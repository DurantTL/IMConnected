// Issue #156: refresh the header and footer of a prerendered (or browser-cached) page from `GET /api/navigation`.
// Only textContent and validated hrefs are written, never HTML. A part the configuration hides is removed; a part
// the page does not have is left alone (a reload picks it up). Anything malformed leaves the page as rendered.
import { SITE } from '../lib/site';
import { safeChromeUrl, splitIntro, STRIP_DEFAULT, type PublicChrome } from '../lib/site-chrome';

const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
const link = (v: unknown): { label: string; url: string } | null => {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>, label = str(r.label, 254), url = safeChromeUrl(r.url, r.contact === true); // mailto only for the contact email entry
  return label && url ? { label, url } : null;
};
const all = (doc: ParentNode, sel: string) => Array.from(doc.querySelectorAll<HTMLElement>(sel));

export function applyChrome(raw: unknown, doc: Document): void {
  if (!raw || typeof raw !== 'object') return;
  const c = raw as PublicChrome;
  if (!c.header || !c.footer) return;
  const h = c.header, f = c.footer;
  const gone = (name: string) => all(doc, `[data-chrome="${name}"]`).forEach((e) => e.remove());

  // Header
  if (h.topLine === null) gone('topline');
  else { const t = str(h.topLine?.text), l = link(h.topLine?.link);
    if (t && l) {
      all(doc, '[data-chrome-text="topline"]').forEach((e) => { e.textContent = t; });
      all(doc, '[data-chrome-link="topline"]').forEach((a) => { (a as HTMLAnchorElement).href = l.url; const first = a.firstChild; if (first && first.nodeType === 3) first.textContent = l.label + ' '; });
    } }
  if (h.mastheadNote === null) gone('note');
  else if (Array.isArray(h.mastheadNote) && h.mastheadNote.length === 3) {
    const [a, b, d] = h.mastheadNote.map((x) => str(x));
    if (a && b && d) all(doc, '[data-chrome="note"]').forEach((p) => { const s = doc.createElement('strong'); s.textContent = d; p.replaceChildren(a, doc.createElement('br'), b, doc.createElement('br'), s); });
  }
  if (h.strip === null) gone('strip');
  else { const t = str(h.strip); if (t) all(doc, '[data-chrome-text="strip"]').forEach((p) => {
    // The default wording stays decoration beside the screen-reader publisher name; any other wording is ordinary visible text.
    const visible = doc.createElement('span'); visible.textContent = t;
    if (t === STRIP_DEFAULT) { visible.setAttribute('aria-hidden', 'true'); const sr = doc.createElement('span'); sr.className = 'sr-only'; sr.textContent = SITE.publisher; p.replaceChildren(visible, sr); } else p.replaceChildren(visible);
  }); }
  if (h.edition === '') gone('edition');
  else { const t = str(h.edition); if (t) all(doc, '[data-chrome="edition"]').forEach((e) => { e.textContent = t; }); }
  if (h.search === false) gone('search');
  if (h.submit === null) gone('submit');
  else { const t = str(h.submit); if (t) all(doc, '[data-chrome="submit"]').forEach((e) => { e.textContent = t; }); }

  // Footer
  const st = f.statement;
  if (st) {
    const a = str(st.line1), b = str(st.line2);
    if (a && b) all(doc, '[data-chrome="statement-text"]').forEach((p) => { const em = doc.createElement('em'); em.textContent = b; p.replaceChildren(a, doc.createElement('br'), em); });
    if (st.button === null) gone('statement-button');
    else { const l = link(st.button); if (l) all(doc, '[data-chrome="statement-button"]').forEach((e) => { (e as HTMLAnchorElement).href = l.url; const arrow = doc.createElement('span'); arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '↗'; e.replaceChildren(l.label + ' ', arrow); }); }
  }
  if (f.intro === '') gone('intro');
  else { const t = str(f.intro, 400); if (t) all(doc, '[data-chrome="intro"]').forEach((p) => {
    const parts = splitIntro(t);
    if (!parts) { p.textContent = t; return; }
    const a = doc.createElement('a'); a.href = SITE.publisherUrl; a.textContent = parts[1]; p.replaceChildren(parts[0], a, parts[2]);
  }); }
  if (f.sections === null) gone('sections');
  else { const t = str(f.sections?.heading); if (t) all(doc, '[data-chrome-text="sections-heading"]').forEach((e) => { e.textContent = t; }); }
  if (f.involved === null) gone('involved');
  else if (f.involved) {
    const t = str(f.involved.heading), links = Array.isArray(f.involved.links) ? f.involved.links.map(link) : [];
    if (t && links.length && links.every(Boolean)) {
      all(doc, '[data-chrome-text="involved-heading"]').forEach((e) => { e.textContent = t; });
      all(doc, '[data-chrome-list="involved"]').forEach((ul) => ul.replaceChildren(...links.map((l) => { const li = doc.createElement('li'), a = doc.createElement('a'); a.href = l!.url; a.textContent = l!.label; li.append(a); return li; })));
    }
  }
  const holder = str(f.copyright, 200);
  if (holder) all(doc, '[data-chrome="copyright"]').forEach((e) => { e.textContent = `© ${new Date().getFullYear()} ${holder}. All rights reserved.`; });
  if (f.editor === false) gone('editor');
}
