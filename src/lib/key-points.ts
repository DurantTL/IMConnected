// Key points (issue #117, migration 033): up to three short bullets a story may carry. Plain text only, one line each,
// stored raw as a JSON array and escaped on output (never HTML or Markdown), like photo captions.
export const KEY_POINT_LIMITS = { count: 3, length: 160 };

/** One point as stored: control characters and line breaks collapsed to single spaces, trimmed. */
function cleanPoint(v: string): string {
  return v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lenient: for stored JSON, forms and old revisions. Anything that is not a list of strings is `[]`; empties are dropped; extras and overlong points are cut. */
export function normalizeKeyPoints(v: unknown): string[] {
  let list: unknown = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is string => typeof p === 'string').map(cleanPoint).filter(Boolean).slice(0, KEY_POINT_LIMITS.count).map((p) => p.slice(0, KEY_POINT_LIMITS.length));
}

/** Strict: for the agent API and the editor. Returns the cleaned list, or throws an Error with a readable message. `null` and `[]` clear. */
export function validateKeyPoints(v: unknown): string[] {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error('keyPoints must be a list of up to 3 short text points, or null to clear.');
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string') throw new Error('Each key point must be text.');
    const c = cleanPoint(p);
    if (!c) continue;
    if (c.length > KEY_POINT_LIMITS.length) throw new Error(`A key point is longer than ${KEY_POINT_LIMITS.length} characters.`);
    out.push(c);
  }
  if (out.length > KEY_POINT_LIMITS.count) throw new Error(`Use at most ${KEY_POINT_LIMITS.count} key points.`);
  return out;
}

export const keyPointsJson = (v: unknown): string => JSON.stringify(normalizeKeyPoints(v));
