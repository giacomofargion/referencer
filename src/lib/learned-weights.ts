import type { MatchGenre } from "@/lib/genres";
import { clampMultiplier, type WeightMultipliers } from "@/lib/matching";

// `sql` is imported dynamically inside each DB-touching function below,
// not at module top — src/lib/db.ts throws at import time if DATABASE_URL
// isn't set, which would otherwise make every pure function in this file
// (learningRate, decayFactor, ...) un-importable from a plain `node:test`
// run that has no reason to load env vars. See scripts/seed-shelf.ts for
// the same pattern used for the same reason.

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

export type FeedbackSource = "engage" | "save" | "reject";

/** n=0 -> 0.05, shrinking as a genre's own sample count grows — never zero. */
const STEP_MAX = 0.05;
const HALF_LIFE_SAMPLES = 20;

/** A genre untouched for GRACE_DAYS is unaffected; it then relaxes toward 1.0. */
const GRACE_DAYS = 14;
const DECAY_WINDOW_DAYS = 60;

/** An explicit save is a far more confident signal than carousel drift. */
const SAVE_STEP_MULTIPLIER = 3;
/** Deliberately less than a save — a rejection only tells us this one is wrong. */
const REJECT_STEP_MULTIPLIER = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Shrinking learning rate: early per-genre samples move it more than later ones. */
export function learningRate(sampleCount: number): number {
  return STEP_MAX / (1 + sampleCount / HALF_LIFE_SAMPLES);
}

/** 1 inside the grace window, falling linearly to 0 over the decay window. */
export function decayFactor(elapsedDays: number): number {
  if (elapsedDays <= GRACE_DAYS) return 1;
  return Math.max(0, 1 - (elapsedDays - GRACE_DAYS) / DECAY_WINDOW_DAYS);
}

/**
 * Lazy, read-time staleness decay back toward neutral (1.0) — no cron needed.
 * A genre row that hasn't been touched in a while reads closer to neutral
 * without anything ever writing that back, until fresh feedback arrives.
 */
export function applyStaleDecay(
  multipliers: WeightMultipliers,
  updatedAt: Date,
  now: Date,
): WeightMultipliers {
  const elapsedDays = (now.getTime() - updatedAt.getTime()) / MS_PER_DAY;
  const factor = decayFactor(elapsedDays);
  const out: WeightMultipliers = {};
  for (const key of Object.keys(multipliers) as Array<keyof WeightMultipliers>) {
    const value = multipliers[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = clampMultiplier(1 + (value - 1) * factor);
  }
  return out;
}

function stepMultiplierFor(source: FeedbackSource): number {
  switch (source) {
    case "save":
      return SAVE_STEP_MULTIPLIER;
    case "reject":
      return REJECT_STEP_MULTIPLIER;
    case "engage":
      return 1;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/**
 * Promote axes where the chosen match was closer than top (they predict
 * preference); demote axes where top was closer (they don't). A rejection
 * has no positive counterpart to promote — it only tells us which axes made
 * a wrong match look deceptively close, so those get demoted and nothing
 * gets promoted.
 */
export function computeNudgedMultipliers(input: {
  current: WeightMultipliers;
  sampleCount: number;
  chosenCloserGroups: Array<keyof WeightMultipliers>;
  skippedCloserGroups: Array<keyof WeightMultipliers>;
  source: FeedbackSource;
}): WeightMultipliers {
  const rate = learningRate(input.sampleCount) * stepMultiplierFor(input.source);
  const current: Required<WeightMultipliers> = {
    ...DEFAULT_MULTIPLIERS,
    ...input.current,
  };

  const promote =
    input.source === "reject" ? [] : input.chosenCloserGroups;
  const demote =
    input.source === "reject" ? input.chosenCloserGroups : input.skippedCloserGroups;

  for (const key of promote) {
    current[key] = clampMultiplier(current[key] * (1 + rate));
  }
  for (const key of demote) {
    current[key] = clampMultiplier(current[key] * (1 - rate));
  }
  return current;
}

function parseMultipliers(raw: unknown): WeightMultipliers {
  if (typeof raw !== "object" || raw === null) return {};
  const out: WeightMultipliers = {};
  for (const key of Object.keys(DEFAULT_MULTIPLIERS) as Array<
    keyof WeightMultipliers
  >) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = clampMultiplier(v);
    }
  }
  return out;
}

function parseUpdatedAt(value: unknown): Date {
  return typeof value === "string" ? new Date(value) : (value as Date);
}

/** Genre-scoped, decayed weight multipliers for one live search. Read-only. */
export async function getLearnedWeightMultipliers(
  genre: MatchGenre,
): Promise<WeightMultipliers> {
  try {
    const { sql } = await import("@/lib/db");
    const rows = await sql`
      SELECT multipliers, updated_at
      FROM ranking_weight_state
      WHERE genre = ${genre}
      LIMIT 1
    `;
    if (rows.length === 0) return {};
    const multipliers = parseMultipliers(rows[0].multipliers);
    const updatedAt = parseUpdatedAt(rows[0].updated_at);
    return applyStaleDecay(multipliers, updatedAt, new Date());
  } catch {
    // Table may not exist yet before migration 006.
    return {};
  }
}

/**
 * Nudge one genre's weight groups toward features where the chosen match was
 * closer than the top result (or, for a rejection, away from features that
 * made it look deceptively close). Applies staleness decay to the row's
 * *current* state first, so a long-dormant genre catches up on read instead
 * of needing a scheduled job.
 */
export async function nudgeWeightsFromPreference(input: {
  genre: MatchGenre;
  chosenCloserGroups: Array<keyof WeightMultipliers>;
  skippedCloserGroups: Array<keyof WeightMultipliers>;
  source: FeedbackSource;
}): Promise<void> {
  try {
    const { sql } = await import("@/lib/db");
    const rows = await sql`
      SELECT multipliers, sample_count, updated_at
      FROM ranking_weight_state
      WHERE genre = ${input.genre}
      LIMIT 1
    `;
    const sampleCount = rows.length > 0 ? Number(rows[0].sample_count ?? 0) : 0;
    const effectiveCurrent =
      rows.length > 0
        ? applyStaleDecay(
            parseMultipliers(rows[0].multipliers),
            parseUpdatedAt(rows[0].updated_at),
            new Date(),
          )
        : {};

    const next = computeNudgedMultipliers({
      current: effectiveCurrent,
      sampleCount,
      chosenCloserGroups: input.chosenCloserGroups,
      skippedCloserGroups: input.skippedCloserGroups,
      source: input.source,
    });

    await sql`
      INSERT INTO ranking_weight_state (genre, multipliers, updated_at, sample_count)
      VALUES (${input.genre}, ${JSON.stringify(next)}::jsonb, now(), 1)
      ON CONFLICT (genre) DO UPDATE SET
        multipliers = ${JSON.stringify(next)}::jsonb,
        updated_at = now(),
        sample_count = ranking_weight_state.sample_count + 1
    `;
  } catch (error) {
    console.warn("Weight nudge skipped:", error);
  }
}
