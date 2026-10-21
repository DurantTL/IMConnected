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
/** Only this many words are searched as prefixes (the rest must match whole words), and one-letter words are never prefixes. */
export const MAX_PREFIX_TERMS = 4;
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

/**
 * The FTS5 MATCH string: every word in double quotes, all required. The first MAX_PREFIX_TERMS words of two or more
 * characters are prefix matches; one-letter words and any further words must match a whole word, because a one-letter
 * prefix scans most of the index. Words hold letters and digits only.
 */
export function ftsQuery(terms: string[]): string {
  let prefixes = 0;
  return terms.map((t) => {
    const prefix = t.length >= 2 && prefixes < MAX_PREFIX_TERMS;
    if (prefix) prefixes++;
    return `"${t.replace(/"/g, '')}"${prefix ? '*' : ''}`;
  }).join(' ');
}

interface Rule { t: string; prefix: boolean }
/** How each word is matched, the same rule ftsQuery() gives FTS5, so the in-memory search and the highlights agree with the index. */
export function matchRules(terms: string[]): Rule[] {
  let prefixes = 0;
  return terms.map((raw) => {
    const prefix = raw.length >= 2 && prefixes < MAX_PREFIX_TERMS;
    if (prefix) prefixes++;
    return { t: fold(raw), prefix };
  });
}
const ruleHit = (r: Rule, folded: string) => (r.prefix ? folded.startsWith(r.t) : folded === r.t);

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
 * escaped again on the way out. Control and private-use characters are replaced by spaces.
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
    .replace(/[\u0000-\u001f\u007f\ue000-\uf8ff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Plain text for an indexed field (title, dek, author, church): control and private-use characters out. */
export function cleanField(s: string | undefined | null): string {
  return (s ?? '').replace(/[\u0000-\u001f\u007f\ue000-\uf8ff]/g, ' ').replace(/\s+/g, ' ').trim();
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
  const rules = matchRules(terms);
  const hit = (w: { folded: string }) => rules.some((r) => ruleHit(r, w.folded));
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

/** The folded words of a text (what the in-memory search keeps per story). */
export const foldedWords = (text: string): string[] => wordsOf(text).map((w) => w.folded);
/** True when every search word matches one of the folded words. */
export const matchesWords = (terms: string[], words: string[]): boolean => matchRules(terms).every((r) => words.some((w) => ruleHit(r, w)));
/** How many search words match a word of the title (the in-memory ranking). */
export const titleScore = (terms: string[], titleWords: string[]): number => matchRules(terms).filter((r) => titleWords.some((w) => ruleHit(r, w))).length;

/** True when every search word matches some word in `text`. */
export function matchesAll(text: string, terms: string[]): boolean {
  const folded = wordsOf(text).map((w) => w.folded);
  return matchRules(terms).every((r) => folded.some((w) => ruleHit(r, w)));
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
  const rules = matchRules(terms);
  const has = (text: string) => wordsOf(text).some((w) => rules.some((r) => ruleHit(r, w.folded)));
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
