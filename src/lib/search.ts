// Story search, the pure part (epic #25, step 3): turning a visitor's text into a safe query, plain text out of
// Markdown, and escaped, highlighted snippets. No imports from the database or Astro, so both the SQLite FTS5 path
// (search-index.ts) and the in-memory fallback over the built collection (search-run.ts) share it.
//
// The rules that matter:
//   * Nothing a visitor types reaches FTS5 as syntax. parseQuery() keeps only runs of letters and digits (every quote,
//     star, bracket, colon, minus, caret and NEAR( falls away as punctuation) and ftsQuery() puts each one in double
//     quotes with a trailing prefix star. A word like AND or NEAR is then just a quoted word.
//   * Nothing stored reaches the page as HTML. Snippets are cut from plain text, every piece is escaped with escapeHtml(),
//     and only then are the <mark> tags wrapped around the matching words.

export const MAX_QUERY_CHARS = 200;
export const MAX_TERMS = 8;
export const MAX_TERM_CHARS = 40;
export const MAX_RESULTS = 20;
const SNIPPET_CHARS = 200;

export type ParsedQuery = { ok: true; terms: string[] } | { ok: false; error: string };

/** Words to search for, or a short message for the visitor. Never throws. */
export function parseQuery(raw: string): ParsedQuery {
  if (raw.length > MAX_QUERY_CHARS) return { ok: false, error: `Please keep your search under ${MAX_QUERY_CHARS} characters.` };
  let text = raw;
  try { text = raw.normalize('NFKC'); } catch { /* keep the raw text */ }
  const found = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  for (const w of found) {
    const t = w.toLowerCase().slice(0, MAX_TERM_CHARS);
    if (!terms.includes(t)) terms.push(t);
    if (terms.length >= MAX_TERMS) break;
  }
  if (!terms.length) return { ok: false, error: 'Type a word or two to search for.' };
  return { ok: true, terms };
}

/** The FTS5 MATCH string: every word in double quotes, as a prefix match, all required. Words hold letters and digits only. */
export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

/** Lower case with accents removed, the same folding the FTS tokenizer does (unicode61 remove_diacritics). */
export function fold(s: string): string {
  let out = s;
  try { out = s.normalize('NFKD').replace(/\p{M}/gu, ''); } catch { /* keep as is */ }
  return out.toLowerCase();
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&amp;': '&' };

/**
 * The words of a Markdown story as plain text: links and images keep their text, markup characters and tags go,
 * escapes and entities are turned back into characters. It only ever feeds the index and the snippets, which are
 * escaped again on the way out. The private-use characters are removed so they can never be mistaken for markers.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^\s{0,3}(```|~~~).*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, ' ')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!<>&|])/g, '$1')
    .replace(/&(?:lt|gt|quot|#39|#x27|amp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[\u0000-\u001f\u007f-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain text for an indexed field (title, dek, author, church): control and private-use characters out. */
export function cleanField(s: string | undefined | null): string {
  return (s ?? '').replace(/[\u0000-\u001f\u007f-]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

/** The words of a text with their positions and folded forms. */
function wordsOf(text: string): { word: string; index: number; folded: string }[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ word: m[0], index: m.index ?? 0, folded: fold(m[0]) }));
}

/**
 * An HTML snippet of about 200 characters around the first match: text escaped first, then <mark> around each word
 * that starts with a search word. With no match it is the start of the text. The only tags in the result are
 * <mark> and </mark>.
 */
export function snippetHtml(text: string, terms: string[]): string {
  if (!text) return '';
  const words = wordsOf(text);
  const folded = terms.map(fold);
  const hit = (w: { folded: string }) => folded.some((t) => w.folded.startsWith(t));
  const first = words.find(hit);
  let start = first ? Math.max(0, first.index - 60) : 0;
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp !== -1 && sp < (first?.index ?? start)) start = sp + 1; }
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > start + 40) end = sp; }
  let out = start > 0 ? '… ' : '';
  let cursor = start;
  for (const w of words) {
    if (w.index < start) continue;
    if (w.index + w.word.length > end) break;
    out += escapeHtml(text.slice(cursor, w.index));
    out += hit(w) ? `<mark>${escapeHtml(w.word)}</mark>` : escapeHtml(w.word);
    cursor = w.index + w.word.length;
  }
  out += escapeHtml(text.slice(cursor, end));
  if (end < text.length) out += ' …';
  return out;
}

/** True when every search word is the start of some word in `text`. */
export function matchesAll(text: string, terms: string[]): boolean {
  const folded = wordsOf(text).map((w) => w.folded);
  return terms.map(fold).every((t) => folded.some((w) => w.startsWith(t)));
}

export interface SearchableStory {
  slug: string;
  title: string;
  dek?: string;
  author: string;
  church?: string;
  section: string;
  /** YYYY-MM-DD */
  date: string;
  /** Markdown source */
  body: string;
}

export interface SearchHit {
  slug: string;
  url: string;
  title: string;
  section: string;
  /** YYYY-MM-DD */
  date: string;
  author: string;
  church?: string;
  /** Escaped text; the only markup is <mark>. */
  snippet: string;
}

/** The result for one story: plain-text fields as JSON strings, and the snippet as escaped HTML with <mark>. */
export function toHit(s: SearchableStory, terms: string[]): SearchHit {
  const body = plainText(s.body);
  const dek = cleanField(s.dek);
  const folded = terms.map(fold);
  const has = (text: string) => wordsOf(text).some((w) => folded.some((t) => w.folded.startsWith(t)));
  const source = has(body) ? body : has(dek) ? dek : dek || body;
  return {
    slug: s.slug,
    url: `/stories/${s.slug}/`,
    title: cleanField(s.title),
    section: s.section,
    date: s.date,
    author: cleanField(s.author),
    ...(s.church ? { church: cleanField(s.church) } : {}),
    snippet: snippetHtml(source, terms),
  };
}
