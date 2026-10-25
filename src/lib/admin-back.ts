// "Back to the list" addresses for the dashboard lists (issue #148).
// A row action or bulk action carries the list's own address as a `back` value so it can return to the same filtered,
// sorted, paged view. The value comes from a form field, so it is NEVER trusted or echoed: it is only parsed into a
// filter, and the address is rebuilt from that filter. The result is always one of the four fixed list paths plus a
// canonical query of whitelisted values, so it can never be an absolute URL, another path or a protocol-relative value.
import { parsePublishedFilter, type PublishedFilter } from './story-store';
import { normalizeDraftFilter, DRAFT_SORTS, type DraftListFilter } from './drafts';
import { KIND_PATH, listHref, type ListView } from './draft-list-ui';

export const PUBLISHED_PATH = '/admin/published';
const BACK_MAX = 2000;

/** The Published list address for a filter, leaving out every default. */
export function publishedHref(g: PublishedFilter): string {
  const p = new URLSearchParams();
  if (g.kind !== 'all') p.set('kind', g.kind);
  if (g.q) p.set('q', g.q);
  if (g.section) p.set('section', g.section);
  if (g.area) p.set('area', g.area);
  if (g.issue !== null) p.set('issue', String(g.issue));
  if (g.year) p.set('year', g.year);
  if (g.featured) p.set('featured', 'yes');
  if (g.openDraft) p.set('openDraft', 'yes');
  if (g.editedThisMonth) p.set('edited', 'month');
  if (g.sort !== 'published_desc') p.set('sort', g.sort);
  if (g.perPage !== 25) p.set('perPage', String(g.perPage));
  if (g.page > 1) p.set('page', String(g.page));
  const s = p.toString();
  return PUBLISHED_PATH + (s ? '?' + s : '');
}

/**
 * Split a `back` value into a path (or '' for a bare query string) and its query. A value that starts with "/" must be
 * exactly one of `paths` before any "?"; anything else makes `ok` false. A bare query string may start with "?".
 */
function splitBack(raw: unknown, paths: readonly string[]): { ok: boolean; path: string; query: URLSearchParams } {
  const none = { ok: false, path: '', query: new URLSearchParams() };
  if (typeof raw !== 'string' || raw.length > BACK_MAX) return none;
  let value = raw.trim();
  let path = '';
  if (value.startsWith('/')) {
    const cut = value.indexOf('?');
    path = cut === -1 ? value : value.slice(0, cut);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    value = cut === -1 ? '' : value.slice(cut + 1);
    if (!paths.includes(path)) return none;
  } else if (value.startsWith('?')) value = value.slice(1);
  try { return { ok: true, path, query: new URLSearchParams(value) }; } catch { return none; }
}

/** The canonical Published list address for a `back` value, or the plain list when it is missing or not ours. */
export function safePublishedBack(raw: unknown): string {
  const { ok, query } = splitBack(raw, [PUBLISHED_PATH]);
  return ok ? publishedHref(parsePublishedFilter(query)) : PUBLISHED_PATH;
}

const DRAFT_PATHS: readonly string[] = Object.values(KIND_PATH);
const DRAFT_KEYS = ['q', 'status', 'section', 'source', 'issue', 'from', 'to', 'sort', 'perPage', 'page', 'livePage'] as const;

/**
 * The canonical drafts list address for a `back` value: one of /admin, /admin/announcements, /admin/events plus a query
 * rebuilt from normalizeDraftFilter. The preset paths fix the type (a `kind` parameter is ignored there, as on the page).
 */
export function safeDraftBack(raw: unknown): string {
  const { ok, path, query } = splitBack(raw, DRAFT_PATHS);
  if (!ok) return KIND_PATH.story;
  const preset = (Object.entries(KIND_PATH).find(([kind, p]) => kind !== 'story' && p === path)?.[0] ?? null) as DraftListFilter['kind'] | null;
  const input = Object.fromEntries(DRAFT_KEYS.map((k) => [k, query.get(k)]));
  const filter = normalizeDraftFilter({ ...input, kind: preset ?? query.get('kind') }, 'story');
  const asked = input.sort;
  const view: ListView = { filter, sortParam: DRAFT_SORTS.some((o) => o.value === asked) ? (asked as ListView['sortParam']) : '' };
  return listHref(view);
}

/**
 * Where a row or bulk action on a live story returns to (issue #168). The Published list's own address first, then one of
 * the drafts list pages (the live section on /admin/announcements and /admin/events), otherwise the plain Published list.
 * Both results are rebuilt from a parsed filter; the raw value is never echoed.
 */
export function safeLiveBack(raw: unknown): string {
  const pub = splitBack(raw, [PUBLISHED_PATH]);
  if (pub.ok && (pub.path === PUBLISHED_PATH || pub.path === '')) return safePublishedBack(raw);
  if (splitBack(raw, DRAFT_PATHS).ok) return safeDraftBack(raw);
  return PUBLISHED_PATH;
}

/** True when a rebuilt back address is the Announcements or Events page, whose live section (#live) the action came from. */
export function isLiveSectionPage(rebuilt: string): boolean {
  const path = rebuilt.split('?')[0];
  return path === '/admin/announcements' || path === '/admin/events';
}
