import { sql } from "@/lib/db";
import type { WeightMultipliers } from "@/lib/matching";

const DEFAULT_MULTIPLIERS: Required<WeightMultipliers> = {
  loudness: 1,
  dynamicRange: 1,
  plr: 1,
  tempo: 1,
  onsets: 1,
  stereoWidth: 1,
  band: 1,
  timbre: 1,
  chroma: 1,
  rhythm: 1,
  dynamicsExt: 1,
};

function clamp(value: number): number {
  return Math.min(1.3, Math.max(0.7, value));
}

function parseMultipliers(raw: unknown): WeightMultipliers {
  if (typeof raw !== "object" || raw === null) return {};
  const out: WeightMultipliers = {};
  for (const key of Object.keys(DEFAULT_MULTIPLIERS) as Array<
    keyof WeightMultipliers
  >) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = clamp(v);
    }
  }
  return out;
}

/** Global gentle weight multipliers learned from non-top match clicks. */
export async function getLearnedWeightMultipliers(): Promise<WeightMultipliers> {
  try {
    const rows = await sql`
      SELECT multipliers
      FROM ranking_weight_state
      WHERE id = 1
      LIMIT 1
    `;
    if (rows.length === 0) return {};
    return parseMultipliers(rows[0].multipliers);
  } catch {
    // Table may not exist yet before migration 005.
    return {};
  }
}

/**
 * Nudge weight groups toward features where the chosen (non-top) match
 * was closer than the top result. Exponential step, clamped ±30%.
 */
export async function nudgeWeightsFromPreference(input: {
  chosenCloserGroups: Array<keyof WeightMultipliers>;
  skippedCloserGroups: Array<keyof WeightMultipliers>;
}): Promise<void> {
  const STEP = 0.03;
  try {
    const current = {
      ...DEFAULT_MULTIPLIERS,
      ...(await getLearnedWeightMultipliers()),
    };

    for (const key of input.chosenCloserGroups) {
      current[key] = clamp(current[key] * (1 + STEP));
    }
    for (const key of input.skippedCloserGroups) {
      current[key] = clamp(current[key] * (1 - STEP));
    }

    await sql`
      INSERT INTO ranking_weight_state (id, multipliers, updated_at, sample_count)
      VALUES (1, ${JSON.stringify(current)}::jsonb, now(), 1)
      ON CONFLICT (id) DO UPDATE SET
        multipliers = ${JSON.stringify(current)}::jsonb,
        updated_at = now(),
        sample_count = ranking_weight_state.sample_count + 1
    `;
  } catch (error) {
    console.warn("Weight nudge skipped:", error);
  }
}
