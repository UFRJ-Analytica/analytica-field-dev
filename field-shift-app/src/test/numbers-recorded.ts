/**
 * The one numbers fixture of this suite.
 *
 * `numbers-recorded.json` is the response of `POST /fields/mt-santa-carmem-01/numbers` for the
 * Brazil fixture field, the chosen date 2026-11-12 and the request body the surface sends for a
 * fixture field (its own boundary ring, its centre, `area_ha` null). It is recorded from the
 * shipped pipeline, not written by hand: `python3 scripts/record_numbers_fixture.py` regenerates
 * it and `--check` compares the committed bytes with a fresh run. A fixture the backend cannot
 * produce is worse than no test, because it passes on code the real payload kills (block 6
 * repair, defects D1 to D5).
 *
 * Do not add a second numbers payload to the suite: a test that needs a variation derives it from
 * this response and says what it changed.
 */
import recorded from './numbers-recorded.json'
import type { NumbersPayload } from '@/lib/numbers'

export const RECORDED_FIELD_ID = 'mt-santa-carmem-01'
export const RECORDED_DATE = '2026-11-12'

/**
 * A JSON module widens every string literal (`'br'` reads as `string`), so the recorded document
 * crosses the module boundary through a cast. The behavioural tests are the contract: they render
 * the surface from exactly these bytes.
 */
const PAYLOAD = recorded as unknown as NumbersPayload

/** A fresh copy per call, so a test that edits its own payload cannot reach another test. */
export function recordedNumbersPayload(): NumbersPayload {
  return structuredClone(PAYLOAD)
}
