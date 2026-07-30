import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import {
  CREDIT_PACKS,
  creditPriceCents,
  findCreditPack,
  priceForQuantity,
} from "@/lib/credits";
import { getStripe, isStripeConfigured } from "@/lib/stripe";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Payments are not configured on this server" },
      { status: 503 },
    );
  }

  let quantity = 5;
  try {
    const body = (await request.json()) as { quantity?: unknown };
    if (typeof body.quantity === "number" && Number.isInteger(body.quantity)) {
      quantity = body.quantity;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pack = findCreditPack(quantity);
  if (!pack) {
    return NextResponse.json(
      {
        error: `Choose a pack: ${CREDIT_PACKS.map((p) => p.quantity).join(", ")} credits`,
      },
      { status: 400 },
    );
  }

  const baseUnit = creditPriceCents();
  const { unitCents, totalCents } = priceForQuantity(quantity);
  const origin = new URL(request.url).origin;
  const stripe = getStripe();
  const savePct =
    baseUnit > unitCents
      ? Math.round((1 - unitCents / baseUnit) * 100)
      : 0;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    success_url: `${origin}/?credits=success`,
    cancel_url: `${origin}/?credits=canceled`,
    client_reference_id: userId,
    metadata: {
      clerk_user_id: userId,
      credit_quantity: String(quantity),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "gbp",
          // One line item for the whole pack keeps the Stripe receipt clear.
          unit_amount: totalCents,
          product_data: {
            name: `${quantity} similarity search credits`,
            description:
              savePct > 0
                ? `${formatPence(unitCents)} each (${savePct}% off ${formatPence(baseUnit)})`
                : `${formatPence(unitCents)} each · 1 credit = 1 search`,
          },
        },
      },
    ],
  });

  if (!session.url) {
    return NextResponse.json(
      { error: "Could not create checkout session" },
      { status: 502 },
    );
  }

  return NextResponse.json({ url: session.url });
}

function formatPence(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(pence / 100);
}
