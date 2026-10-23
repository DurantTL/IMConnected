// Public navigation contract; safe to share with the browser. Section definitions remain in site.ts.
import { SECTIONS } from './site';
export interface NavigationItem { id: string; label: string; href: string; visible: boolean }
export interface Navigation { version: number; items: NavigationItem[]; newsletterSignup: string }
export const NAVIGATION_LIMIT = 12;
export function defaultNavigation(): NavigationItem[] {
  return [{ id: 'home', label: 'Latest', href: '/', visible: true }, ...SECTIONS.map((s) => ({ id: s.key, label: s.label, href: `/${s.key}/`, visible: true })), { id: 'announcements', label: 'Announcements', href: '/announcements/', visible: true }, { id: 'issues', label: 'Issues', href: '/issues/', visible: true }];
}
export function navigationHref(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f\\<>"']/.test(value)) throw new Error('Use a public /page/ address or a full HTTPS link.');
  const local = value.startsWith('/') && !value.startsWith('//');
  const u = new URL(value, 'https://navigation.invalid');
  if (u.username || u.password || u.protocol !== 'https:' || (!local && !value.startsWith('https://')) || /^\/(?:admin|api)(?:\/|$)/i.test(decodeURIComponent(u.pathname))) throw new Error('Use a public /page/ address or a full HTTPS link.');
  const href = local ? u.pathname + u.search + u.hash : u.href;
  if (href.length > 2048) throw new Error('Menu addresses must fit within 2,048 characters after URL encoding.');
  return href;
}
// Issue #116: the newsletter signup link is empty (none) or an absolute HTTPS address (same checks as menu links).
export function newsletterSignupHref(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('Use a full HTTPS link for the newsletter signup.');
  const v = value.trim();
  if (!v) return '';
  if (!/^https:\/\//i.test(v)) throw new Error('Use a full HTTPS link for the newsletter signup.');
  try { return navigationHref(v.replace(/^https:\/\//i, 'https://')); } catch { throw new Error('Use a full HTTPS link for the newsletter signup.'); }
}
export function normalizeNavigation(value: unknown): NavigationItem[] {
  if (!Array.isArray(value) || !value.length || value.length > NAVIGATION_LIMIT) throw new Error(`Choose between one and ${NAVIGATION_LIMIT} menu links.`);
  const ids = new Set<string>();
  const items = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each menu link needs a label and address.');
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || ids.has(r.id)) throw new Error('Each menu link needs a unique identity.');
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 40 || /[\u0000-\u001f\u007f]/.test(r.label)) throw new Error('Menu labels must contain 1–40 characters.');
    if (typeof r.visible !== 'boolean') throw new Error('Choose whether each link is visible.');
    ids.add(r.id); return { id: r.id, label: r.label.trim(), href: navigationHref(r.href), visible: r.visible };
  });
  if (!items.some((i) => i.visible)) throw new Error('Keep at least one menu link visible.');
  return items;
}
export function currentNavigation(items: NavigationItem[], current: URL, section?: string): string | undefined {
  const currentPath = current.pathname.replace(/\/$/, '') || '/';
  const storySection = current.pathname.startsWith('/stories/') && SECTIONS.some((s) => s.key === section)
    ? `/${section}` : undefined;
  return items.filter((item) => {
    const url = new URL(item.href, current);
    const path = url.pathname.replace(/\/$/, '') || '/';
    return item.visible && url.origin === current.origin && (
      path === currentPath ||
      path !== '/' && current.pathname.startsWith(path + '/') ||
      path === storySection
    );
  }).sort((a, b) => new URL(b.href, current).pathname.length - new URL(a.href, current).pathname.length)[0]?.id;
}
