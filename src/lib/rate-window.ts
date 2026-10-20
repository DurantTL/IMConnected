// A sliding-window counter shared by the token and per-IP limiters. Plain TypeScript with no imports so a test can load it directly.

/**
 * Prunes `hits` (timestamps in ms) to the window and records `now` only when the request is allowed.
 * A refused request is NOT recorded, so a client that keeps retrying gets in again once its old hits age out.
 */
export function takeSlot(hits: number[], now: number, max: number, windowMs: number): boolean {
  let keep = 0;
  for (const t of hits) if (now - t < windowMs) hits[keep++] = t;
  hits.length = keep;
  if (hits.length >= max) return false;
  hits.push(now);
  return true;
}
