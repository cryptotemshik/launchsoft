/**
 * A number from the environment, with the empty-string trap closed.
 *
 * `Number(process.env.X ?? 120_000)` looks right and is wrong: `??` only fires
 * for undefined, so a variable *present but empty* — `SNIPE_ARM_LEAD_MS=` in a
 * hand-edited env file, the commonest way to half-configure something — falls
 * through to `Number("")`, which is 0 rather than NaN. The setting then reads
 * as a deliberate zero, and whatever it controls quietly stops happening. That
 * is not hypothetical: wave dispatch shipped disabled on every box that way,
 * and the only sign was a startup log line that should have been there.
 *
 * So: an absent or blank variable takes the fallback, and so does anything
 * that isn't a number or is below the floor. Only a real number set by a real
 * person changes anything.
 */
export function envNumber(raw: string | undefined, fallback: number, min = 0): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}
