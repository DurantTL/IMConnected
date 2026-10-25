// Small helpers for the drafts list page (issue #139): canonical URLs for the view and the page-number window.
import type { ContentKind, DraftListFilter, DraftSort } from './drafts';
import { DRAFT_SORTS } from './drafts';

export const KIND_PATH: Record<ContentKind, string> = { story: '/admin', announcement: '/admin/announcements', event: '/admin/events' };
export const KIND_LABEL: Record<ContentKind, string> = { story: 'Story', announcement: 'Announcement', event: 'Event' };
export const sortLabel = (sort: DraftSort) => DRAFT_SORTS.find((s) => s.value === sort)?.label ?? 'Recently updated';

export interface ListView {
  filter: DraftListFilter;
  /** The sort the URL asked for (a valid value), or '' when it relied on the default. */
  sortParam: DraftSort | '';
}

type Overrides = Partial<Omit<DraftListFilter, 'sort'>> & { sort?: DraftSort | '' };

/**
 * The canonical link for the same view with some values changed. Defaults are left out of the query string
 * so a link is as short as it can be; changing anything but the page goes back to page 1.
 */
export function listHref(view: ListView, over: Overrides = {}): string {
  const f: DraftListFilter = { ...view.filter, ...over, sort: view.filter.sort };
  const asked = 'sort' in over ? over.sort || '' : view.sortParam;
  // The default for the resulting status is never written into the URL, so a status link keeps its own default.
  const sortParam = asked === (f.status === 'scheduled' ? 'scheduled' : 'updated') ? '' : asked;
  const params = new URLSearchParams();
  let path = KIND_PATH.story;
  if (f.kind === 'all') params.set('kind', 'all');
  else path = KIND_PATH[f.kind];
  if (f.q) params.set('q', f.q);
  if (f.status !== 'open') params.set('status', f.status);
  if (f.section) params.set('section', f.section);
  if (f.source) params.set('source', f.source);
  if (f.issue) params.set('issue', f.issue);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  if (sortParam) params.set('sort', sortParam);
  if (f.perPage !== 25) params.set('perPage', String(f.perPage));
  // Moving between pages keeps the other table's page; any other change goes back to page 1 of both.
  const onlyPaging = Object.keys(over).every((k) => k === 'page' || k === 'livePage');
  const page = onlyPaging ? (over.page ?? view.filter.page) : 1;
  const livePage = onlyPaging ? (over.livePage ?? view.filter.livePage) : 1;
  if (page > 1) params.set('page', String(page));
  if (livePage > 1 && (f.kind === 'announcement' || f.kind === 'event')) params.set('livePage', String(livePage));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Page numbers to show, with null for a gap: 1 … 4 5 [6] 7 8 … 20. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) { keep.add(2); keep.add(3); }
  if (page >= pages - 2) { keep.add(pages - 1); keep.add(pages - 2); }
  const list = [...keep].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((p, i) => {
    if (i > 0 && p - list[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
}
