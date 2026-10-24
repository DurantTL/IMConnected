// Editable header and footer (issue #156). Plain text only: every value is stored raw and escaped on output
// (Astro, or textContent in the browser), never HTML or Markdown. Safe to import in the browser.
import { SITE } from './site';
import { navigationHref } from './site-navigation';

export const CHROME_LINK_LIMIT = 8;
export interface ChromeLink { label: string; url: string }
export interface HeaderChrome {
  showTopLine: boolean; topLineText: string; topLineLinkLabel: string; topLineLinkUrl: string;
  showMastheadNote: boolean; mastheadNote: [string, string, string];
  showStrip: boolean; stripText: string; edition: string;
  showSearch: boolean; showSubmit: boolean; submitLabel: string;
}
export interface FooterChrome {
  statementLine1: string; statementLine2: string;
  showStatementButton: boolean; statementButtonLabel: string; statementButtonUrl: string;
  intro: string;
  showSections: boolean; sectionsHeading: string;
  involvedHeading: string; involvedLinks: ChromeLink[]; contactEmail: string; contactAfter: number;
  copyright: string; showEditorLink: boolean;
}
export interface SiteChrome { header: HeaderChrome; footer: FooterChrome }
export interface SiteChromeState extends SiteChrome { version: number }

/** Defaults reproduce the header and footer as they were fixed in code. */
export function defaultChrome(): SiteChrome {
  return {
    header: {
      showTopLine: true, topLineText: 'Faith in action. Close to home.', topLineLinkLabel: 'Iowa-Missouri Conference', topLineLinkUrl: SITE.publisherUrl,
      showMastheadNote: true, mastheadNote: ['The stories.', 'The people.', 'Our community.'],
      showStrip: true, stripText: 'Iowa-Missouri Conference', edition: 'Iowa + Missouri',
      showSearch: true, showSubmit: true, submitLabel: 'Submit a Story',
    },
    footer: {
      statementLine1: 'Connected by community.', statementLine2: 'Inspired by faith.',
      showStatementButton: true, statementButtonLabel: 'Share your story', statementButtonUrl: '/submit/',
      intro: `${SITE.tagline}. A publication of the ${SITE.publisher}.`,
      showSections: true, sectionsHeading: 'Sections',
      involvedHeading: 'Get involved',
      involvedLinks: [{ label: 'Submit a story', url: '/submit/' }, { label: 'Search stories', url: '/search/' }, { label: 'imsda.org', url: SITE.publisherUrl }],
      contactEmail: SITE.contactEmail, contactAfter: 2,
      copyright: SITE.publisher, showEditorLink: true,
    },
  };
}

const LIMITS = { short: 80, line: 120, label: 40, intro: 240, heading: 40, copyright: 120, email: 254 };
const EMAIL = /^[^\s@<>"'\\,;:()[\]]+@[^\s@<>"'\\,;:()[\]]+\.[^\s@<>"'\\,;:()[\]]+$/;

function text(v: unknown, name: string, max: number, required = true): string {
  if (typeof v !== 'string') throw new Error(`${name} needs text.`);
  const t = v.trim();
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) throw new Error(`${name} must be one line of plain text.`);
  if (required && !t) throw new Error(`${name} cannot be empty.`);
  if (t.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return t;
}
function flag(v: unknown, name: string): boolean { if (typeof v !== 'boolean') throw new Error(`Choose whether ${name} shows.`); return v; }
function obj(v: unknown, name: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} are missing.`);
  return v as Record<string, unknown>;
}
/** Root-relative or HTTPS (the navigation validator). `https://host` stays without a trailing slash when typed that way. */
export function chromeHref(value: unknown, name = 'Link address'): string {
  const v = typeof value === 'string' ? value.trim() : '';
  let h: string;
  try { h = navigationHref(v); } catch { throw new Error(`${name}: use a public /page/ address or a full HTTPS link.`); }
  if (/^https:\/\/[^/?#]+\/$/.test(h) && !/^https:\/\/[^/?#]+\/$/.test(v)) h = h.slice(0, -1);
  return h;
}
/** Browser-side check for API values: a chrome link or the contact mailto. */
export function safeChromeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^mailto:/i.test(value)) { const a = value.slice(7); return a.length <= LIMITS.email && EMAIL.test(a) ? value : null; }
  try { return chromeHref(value); } catch { return null; }
}

export function normalizeChrome(value: unknown): SiteChrome {
  const root = obj(value, 'The header and footer settings'), h = obj(root.header, 'The header settings'), f = obj(root.footer, 'The footer settings');
  const note = h.mastheadNote;
  if (!Array.isArray(note) || note.length !== 3) throw new Error('The masthead note needs three short lines.');
  const links = f.involvedLinks;
  if (!Array.isArray(links) || links.length > CHROME_LINK_LIMIT) throw new Error(`Use at most ${CHROME_LINK_LIMIT} Get involved links.`);
  const involvedLinks = links.map((raw, i) => {
    const r = obj(raw, `Get involved link ${i + 1}`);
    return { label: text(r.label, `Get involved link ${i + 1} label`, LIMITS.label), url: chromeHref(r.url, `Get involved link ${i + 1}`) };
  });
  const email = text(f.contactEmail, 'Contact email', LIMITS.email, false);
  if (email && !EMAIL.test(email)) throw new Error('Contact email must be an email address like name@example.org.');
  const after = f.contactAfter;
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0 || after > CHROME_LINK_LIMIT) throw new Error(`Choose where the contact email goes (0 to ${CHROME_LINK_LIMIT}).`);
  return {
    header: {
      showTopLine: flag(h.showTopLine, 'the top line'), topLineText: text(h.topLineText, 'Top line text', LIMITS.short),
      topLineLinkLabel: text(h.topLineLinkLabel, 'Top line link label', LIMITS.label), topLineLinkUrl: chromeHref(h.topLineLinkUrl, 'Top line link'),
      showMastheadNote: flag(h.showMastheadNote, 'the masthead note'),
      mastheadNote: [text(note[0], 'Masthead note line 1', LIMITS.short), text(note[1], 'Masthead note line 2', LIMITS.short), text(note[2], 'Masthead note line 3', LIMITS.short)],
      showStrip: flag(h.showStrip, 'the conference strip'), stripText: text(h.stripText, 'Conference strip text', LIMITS.short),
      edition: text(h.edition, 'Edition label', LIMITS.label, false),
      showSearch: flag(h.showSearch, 'the Search link'), showSubmit: flag(h.showSubmit, 'the Submit button'), submitLabel: text(h.submitLabel, 'Submit button label', LIMITS.label),
    },
    footer: {
      statementLine1: text(f.statementLine1, 'Statement line 1', LIMITS.line), statementLine2: text(f.statementLine2, 'Statement line 2', LIMITS.line),
      showStatementButton: flag(f.showStatementButton, 'the statement button'), statementButtonLabel: text(f.statementButtonLabel, 'Statement button label', LIMITS.label), statementButtonUrl: chromeHref(f.statementButtonUrl, 'Statement button'),
      intro: text(f.intro, 'Intro sentence', LIMITS.intro, false),
      showSections: flag(f.showSections, 'the Sections column'), sectionsHeading: text(f.sectionsHeading, 'Sections heading', LIMITS.heading),
      involvedHeading: text(f.involvedHeading, 'Get involved heading', LIMITS.heading), involvedLinks, contactEmail: email, contactAfter: Math.min(after, involvedLinks.length),
      copyright: text(f.copyright, 'Copyright holder', LIMITS.copyright), showEditorLink: flag(f.showEditorLink, 'the Editor sign in link'),
    },
  };
}

/** Dotted names of the values that differ between two normalized configurations (never the values). */
export function changedChromeFields(a: SiteChrome, b: SiteChrome): string[] {
  const out: string[] = [];
  for (const part of ['header', 'footer'] as const) {
    const x = a[part] as unknown as Record<string, unknown>, y = b[part] as unknown as Record<string, unknown>;
    for (const k of Object.keys(y)) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(`${part}.${k}`);
  }
  return out;
}

/** What visitors see: hidden parts are null, so no renderer can leave an empty wrapper. Shared by the server markup and `GET /api/navigation`. */
export interface PublicChrome {
  version: number;
  header: {
    topLine: { text: string; link: ChromeLink } | null;
    mastheadNote: [string, string, string] | null;
    strip: string | null; edition: string; search: boolean; submit: string | null;
  };
  footer: {
    statement: { line1: string; line2: string; button: ChromeLink | null };
    intro: string; sections: { heading: string } | null;
    involved: { heading: string; links: ChromeLink[] } | null;
    copyright: string; editor: boolean;
  };
}
export function publicChrome(c: SiteChromeState): PublicChrome {
  const h = c.header, f = c.footer;
  const links = f.involvedLinks.slice();
  if (f.contactEmail) links.splice(Math.min(f.contactAfter, links.length), 0, { label: f.contactEmail, url: `mailto:${f.contactEmail}` });
  return {
    version: c.version,
    header: {
      topLine: h.showTopLine ? { text: h.topLineText, link: { label: h.topLineLinkLabel, url: h.topLineLinkUrl } } : null,
      mastheadNote: h.showMastheadNote ? h.mastheadNote : null,
      strip: h.showStrip ? h.stripText : null, edition: h.edition, search: h.showSearch, submit: h.showSubmit ? h.submitLabel : null,
    },
    footer: {
      statement: { line1: f.statementLine1, line2: f.statementLine2, button: f.showStatementButton ? { label: f.statementButtonLabel, url: f.statementButtonUrl } : null },
      intro: f.intro, sections: f.showSections ? { heading: f.sectionsHeading } : null,
      involved: links.length ? { heading: f.involvedHeading, links } : null,
      copyright: f.copyright, editor: f.showEditorLink,
    },
  };
}
export const defaultPublicChrome = (): PublicChrome => publicChrome({ version: 0, ...defaultChrome() });

/** The footer intro links the publisher's name when it appears in the sentence: [before, name, after]. */
export function splitIntro(intro: string): [string, string, string] | null {
  const i = intro.indexOf(SITE.publisher);
  return i < 0 ? null : [intro.slice(0, i), SITE.publisher, intro.slice(i + SITE.publisher.length)];
}
