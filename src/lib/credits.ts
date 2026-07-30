import { sql } from "@/lib/db";
import { isOwnerUser } from "@/lib/owner";

export type CreditReason = "purchase" | "match_spend" | "refund" | "grant";

export function freeStarterCredits(): number {
  const raw = process.env.FREE_STARTER_CREDITS?.trim();
  if (raw === undefined || raw === "") return 5;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 5;
  return parsed;
}

/** Price per credit in GBP pence (default 49 = £0.49). */
export function creditPriceCents(): number {
  const raw = process.env.CREDIT_PRICE_CENTS?.trim();
  if (!raw) return 49;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 49;
  return parsed;
}

export interface CreditPack {
  quantity: number;
  /** Pence charged per credit in this pack. */
  unitCents: number;
}

/**
 * Fixed packs with volume discounts off the base CREDIT_PRICE_CENTS.
 * Unit prices are absolute so checkout stays predictable.
 */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { quantity: 5, unitCents: 49 },
  { quantity: 20, unitCents: 39 },
  { quantity: 50, unitCents: 35 },
  { quantity: 100, unitCents: 29 },
] as const;

export function findCreditPack(quantity: number): CreditPack | null {
  return CREDIT_PACKS.find((pack) => pack.quantity === quantity) ?? null;
}

/** Checkout pricing for a quantity — pack rate if matched, else base unit price. */
export function priceForQuantity(quantity: number): {
  unitCents: number;
  totalCents: number;
  pack: CreditPack | null;
} {
  const pack = findCreditPack(quantity);
  const unitCents = pack?.unitCents ?? creditPriceCents();
  return {
    unitCents,
    totalCents: unitCents * quantity,
    pack,
  };
}

async function ensureUserRow(clerkUserId: string): Promise<void> {
  await sql`
    INSERT INTO user_credits (clerk_user_id, balance)
    VALUES (${clerkUserId}, 0)
    ON CONFLICT (clerk_user_id) DO NOTHING
  `;
}

/**
 * One-time free credits for new users. Idempotent via ledger reason=grant.
 * Tunable with FREE_STARTER_CREDITS (default 5).
 */
export async function ensureStarterGrant(clerkUserId: string): Promise<void> {
  const amount = freeStarterCredits();
  if (amount <= 0) {
    await ensureUserRow(clerkUserId);
    return;
  }

  await ensureUserRow(clerkUserId);

  const existing = await sql`
    SELECT id FROM credit_ledger
    WHERE clerk_user_id = ${clerkUserId} AND reason = 'grant'
    LIMIT 1
  `;
  if (existing.length > 0) return;

  // Single statement so HTTP neon driver stays atomic without a Pool.
  // Partial unique index on reason=grant prevents double grants under concurrency.
  try {
    await sql`
      WITH claimed AS (
        INSERT INTO credit_ledger (clerk_user_id, delta, reason)
        VALUES (${clerkUserId}, ${amount}, 'grant')
        ON CONFLICT DO NOTHING
        RETURNING clerk_user_id, delta
      )
      UPDATE user_credits uc
      SET balance = uc.balance + claimed.delta,
          updated_at = now()
      FROM claimed
      WHERE uc.clerk_user_id = claimed.clerk_user_id
    `;
  } catch (error) {
    // Unique violation if a parallel request won the race first.
    const message = error instanceof Error ? error.message : String(error);
    if (!/unique|duplicate/i.test(message)) throw error;
  }
}

export async function getBalance(clerkUserId: string): Promise<number> {
  await ensureStarterGrant(clerkUserId);
  const rows = await sql`
    SELECT balance FROM user_credits
    WHERE clerk_user_id = ${clerkUserId}
    LIMIT 1
  `;
  return Number(rows[0]?.balance ?? 0);
}

/**
 * Atomically spend one credit before a similarity search.
 * Owner accounts skip the debit (unlimited free matches).
 * Returns the new balance, or null if the user has none left.
 */
export async function debitForMatch(
  clerkUserId: string,
  uploadId: string,
): Promise<number | null> {
  if (isOwnerUser(clerkUserId)) {
    return getBalance(clerkUserId);
  }

  await ensureStarterGrant(clerkUserId);

  const rows = await sql`
    WITH depleted AS (
      UPDATE user_credits
      SET balance = balance - 1,
          updated_at = now()
      WHERE clerk_user_id = ${clerkUserId} AND balance >= 1
      RETURNING clerk_user_id, balance
    ),
    logged AS (
      INSERT INTO credit_ledger (clerk_user_id, delta, reason, upload_id)
      SELECT clerk_user_id, -1, 'match_spend', ${uploadId}::uuid
      FROM depleted
      RETURNING clerk_user_id
    )
    SELECT balance FROM depleted
  `;

  if (rows.length === 0) return null;
  return Number(rows[0].balance);
}

/** Refund a credit after a failed match (does not re-grant starter). No-op for owners. */
export async function refundMatch(
  clerkUserId: string,
  uploadId: string,
): Promise<number> {
  if (isOwnerUser(clerkUserId)) {
    return getBalance(clerkUserId);
  }

  const rows = await sql`
    WITH credited AS (
      UPDATE user_credits
      SET balance = balance + 1,
          updated_at = now()
      WHERE clerk_user_id = ${clerkUserId}
      RETURNING clerk_user_id, balance
    ),
    logged AS (
      INSERT INTO credit_ledger (clerk_user_id, delta, reason, upload_id)
      SELECT clerk_user_id, 1, 'refund', ${uploadId}::uuid
      FROM credited
      RETURNING clerk_user_id
    )
    SELECT balance FROM credited
  `;

  return Number(rows[0]?.balance ?? 0);
}

/**
 * Credit a Stripe purchase. Idempotent on stripe_session_id.
 * Returns the new balance, or the current balance if already applied.
 */
export async function creditFromPurchase(input: {
  clerkUserId: string;
  quantity: number;
  stripeSessionId: string;
}): Promise<number> {
  const { clerkUserId, quantity, stripeSessionId } = input;
  if (quantity < 1) {
    throw new Error("Purchase quantity must be at least 1");
  }

  await ensureUserRow(clerkUserId);

  const rows = await sql`
    WITH inserted AS (
      INSERT INTO credit_ledger (
        clerk_user_id, delta, reason, stripe_session_id
      )
      VALUES (
        ${clerkUserId}, ${quantity}, 'purchase', ${stripeSessionId}
      )
      ON CONFLICT (stripe_session_id) DO NOTHING
      RETURNING clerk_user_id, delta
    ),
    bumped AS (
      UPDATE user_credits uc
      SET balance = uc.balance + inserted.delta,
          updated_at = now()
      FROM inserted
      WHERE uc.clerk_user_id = inserted.clerk_user_id
      RETURNING uc.balance
    )
    SELECT balance FROM bumped
  `;

  if (rows.length > 0) {
    return Number(rows[0].balance);
  }

  // Already credited this session — return current balance.
  return getBalance(clerkUserId);
}
