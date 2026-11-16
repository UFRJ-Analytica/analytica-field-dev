/**
 * Client-side mirror of pipeline/scoring.py `weighted_total` and `rank`.
 *
 * The 0-100 component scores come from the pipeline; only the weighting happens here, so the page
 * can re-rank instantly as the farmer moves the sliders, with no server (static mode). Keep in sync
 * with the Python: total = sum(w_i * s_i) / sum(w_i) over components with w_i > 0, and no total if
 * any weighted component is missing.
 */

import type { Component, RotationResult, Weights } from "./api/types";

export const COMPONENTS: Component[] = ["soil", "water", "income"];

export function weightedTotal(r: RotationResult, w: Weights): number | null {
  const used = COMPONENTS.filter((c) => w[c] > 0);
  if (!used.length) return null;
  if (used.some((c) => r[c].score == null)) return null;
  const sumW = used.reduce((a, c) => a + w[c], 0);
  return used.reduce((a, c) => a + w[c] * (r[c].score as number), 0) / sumW;
}

export interface Ranked extends RotationResult {
  myTotal: number | null;
  myRank: number | null;
  /** Components that block a total under these weights. */
  missing: Component[];
}

export function rankRotations(results: RotationResult[], w: Weights): Ranked[] {
  const withTotals = results.map((r) => ({
    ...r,
    myTotal: weightedTotal(r, w),
    myRank: null as number | null,
    missing: COMPONENTS.filter((c) => w[c] > 0 && r[c].score == null),
  }));
  const scored = withTotals.filter((r) => r.myTotal != null).sort((a, b) => (b.myTotal as number) - (a.myTotal as number));
  scored.forEach((r, i) => (r.myRank = i + 1));
  return [...scored, ...withTotals.filter((r) => r.myTotal == null)];
}
