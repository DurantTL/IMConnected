// Paging for the section and area pages (issue #96): 20 stories a page, newest first, page 1 at the plain URL and
// later pages at <plain URL>page/<n>/. Pure string/array work, shared by the routes, the page cache key and the tests.

export const PAGE_SIZE = 20;

/** A canonical page number ("2", never "02", "+2", "2.0" or "1e1"), or null. Bounded so a key can't be absurdly long. */
export function parsePageNumber(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null;
}

export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));

/** The address of page `n` of the list at `base` (ends with a slash, e.g. "/news/"). Page 1 is `base` itself. */
export const pageHref = (base: string, n: number): string => (n <= 1 ? base : `${base}page/${n}/`);

/** Numbers to link: all of them up to 7 pages, else first, last and the neighbours of the current page, with null for a gap. */
export function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current - 1, current, current + 1].filter((n) => n >= 1 && n <= total));
  const out: (number | null)[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  }
  return out;
}
