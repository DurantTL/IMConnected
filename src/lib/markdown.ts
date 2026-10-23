// Server-side Markdown preview and link check for the story editor.
// Uses the same processor as the site (Astro's default, @astrojs/markdown-satteri). That pipeline lets raw
// HTML through, which is exactly why every "<" is escaped first, and why link targets are checked after.
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { escapeHtmlInMarkdown } from './storyfile';

type Renderer = Awaited<ReturnType<typeof createSatteriMarkdownProcessor>>;
let processor: Promise<Renderer> | undefined;
const getProcessor = () => (processor ??= createSatteriMarkdownProcessor({}));

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&(colon|tab|newline);/gi, (_, n: string) => ({ colon: ':', tab: '\t', newline: '\n' })[n.toLowerCase() as 'colon']);
}

/** Only web links, mail links, relative paths and in-page anchors may appear in a story. */
export function safeUrl(raw: string): boolean {
  const v = decodeEntities(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000- \u007f-\u009f]+/g, '')
    .toLowerCase();
  if (/^(https?:|mailto:|tel:)/.test(v)) return true;
  const colon = v.indexOf(':');
  if (colon === -1) return true;
  const stop = v.search(/[/?#]/);
  return stop !== -1 && stop < colon; // a colon only after the first / ? or # is part of a path or query
}

/**
 * Markdown to HTML with raw HTML neutralised. `unsafeLinks` is true when a link or image target used a
 * scheme such as javascript: or data: (those targets are replaced by "#" in the returned HTML).
 */
export async function renderMarkdownSafe(markdown: string): Promise<{ html: string; unsafeLinks: boolean }> {
  const { code } = await (await getProcessor()).render(escapeHtmlInMarkdown(markdown));
  return checkMarkdownLinks(code);
}

/** Shared URL policy for the plain Markdown renderer and trusted inline-media plugin. */
export function checkMarkdownLinks(code: string): { html: string; unsafeLinks: boolean } {
  let unsafeLinks = false;
  const attrs = /\b(href|src|srcset|action|formaction|poster|data|xlink:href)=("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const html = code.replace(/<[a-z][^>]*>/gi, (tag) =>
    tag.replace(attrs, (m, attr: string, _v, dq, sq, bare) => {
      const value = (dq ?? sq ?? bare ?? '') as string;
      const name = attr.toLowerCase();
      if ((name === 'href' || name === 'src') && safeUrl(value)) return m;
      unsafeLinks = true;
      return `${attr}="#"`;
    }),
  );
  return { html, unsafeLinks };
}

/** Image addresses the private editor preview may load: the story's own photos only, never another same-origin path. */
const PREVIEW_IMG = /^(?:\/api\/admin\/photos\/\d{1,12}|\/(?:media|images)\/stories\/[A-Za-z0-9._/-]+|https:\/\/[^\s"'<>]+)$/;
export function restrictPreviewImages(html: string, ownHosts: string[] = []): string {
  const host = (h: string) => h.toLowerCase().replace(/\.$/, ''); // hostnames only (no port); "example.test." is "example.test"
  const own = new Set(ownHosts.map(host));
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    if (!PREVIEW_IMG.test(src) || src.split('/').includes('..') || /\bsrcset=/i.test(tag)) return '';
    if (src.startsWith('https:')) { // the site's own absolute address is the same origin, so it is as private as a relative path
      try { if (own.has(host(new URL(src).hostname))) return ''; } catch { return ''; }
    }
    return tag;
  }).replace(/--fit-src:url\((?:"|&quot;)(.*?)(?:"|&quot;)\);?/g, (decl, raw: string) => {
    // The blur fill is a CSS background, so it needs the same allow-list as <img src>.
    const src = raw.replace(/&amp;/g, '&');
    if (!PREVIEW_IMG.test(src) || src.split('/').includes('..')) return '';
    if (src.startsWith('https:')) { try { if (own.has(host(new URL(src).hostname))) return ''; } catch { return ''; } }
    return decl;
  });
}
