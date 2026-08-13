/**
 * Pure geometry for the card flip. Kept free of JSX so it can be unit tested
 * directly with node --test --experimental-strip-types.
 */

export const DEGREES_PER_CARD = 180;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** True when the card's front is turned away from the viewer. */
export function showsBack(x: number, y: number): boolean {
  return Math.cos(toRadians(x)) * Math.cos(toRadians(y)) < 0;
}

/**
 * Nearest pose that is upright (no in-plane twist) and keeps whichever face the
 * card was showing when the pointer came up.
 *
 * X always lands on a multiple of 360 so the card is never upside down; the
 * face is preserved by choosing the parity of the Y half-turn instead.
 */
export function settlePose(x: number, y: number): { x: number; y: number } {
  const facingBack = showsBack(x, y);
  const turns = y / 180;
  let half = Math.round(turns);
  const wantsOdd = facingBack ? 1 : 0;

  if (Math.abs(half % 2) !== wantsOdd) half += turns >= half ? 1 : -1;

  // -0 renders the same as 0 but is not Object.is-equal to it, which would make
  // React treat an unchanged pose as new state.
  const unsign = (value: number) => (value === 0 ? 0 : value);

  return { x: unsign(Math.round(x / 360) * 360), y: unsign(half * 180) };
}
