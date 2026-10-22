import { createSatteriMarkdownProcessor, type SatteriMarkdownProcessorOptions } from '@astrojs/markdown-satteri';
import { escapeHtml, checkMarkdownLinks, renderMarkdownSafe } from './markdown';
import { escapeHtmlInMarkdown } from './storyfile';
import { photoFocusStyle, isStoryImageUrl } from './story-blocks';
import { photoMarkerIndex, isMediaMarkerLine, type InlineStoryPhoto } from './story-media';

export const INLINE_MEDIA_CSS = '.story-inline-photo{margin:1.4em 0}.story-inline-photo a{display:block;overflow:hidden;border-radius:8px}.story-inline-photo img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;margin:0}.story-media-warning{padding:12px;border:1px solid #a54b10;background:#fff4df;color:#6b3009}';
interface MediaState { photos: InlineStoryPhoto[]; preview: boolean; used: Set<number>; warnings: string[] }

export function renderInlinePhoto(photo: InlineStoryPhoto, preview = false): string {
  let allowed = isStoryImageUrl(photo.src) || preview && /^\/api\/admin\/photos\/\d+$/.test(photo.src);
  try { const url = new URL(photo.src); allowed ||= url.protocol === 'https:' && !url.username && !url.password && !/[\s<>"']/.test(photo.src); } catch { /* relative own-story URLs above */ }
  if (!allowed) return '';
  const alt = photo.alt.replace(/&lt;/g, '<');
  return `<figure class="story-inline-photo"><a href="${escapeHtml(photo.src)}" data-photo${alt.trim() ? '' : ' aria-label="Enlarge story photo"'}><img src="${escapeHtml(photo.src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" style="${photoFocusStyle(photo) ?? ''}"></a></figure>`;
}

// Parse after escaping, at Markdown AST paragraph boundaries. Code spans/fences,
// links and nested structures remain Markdown, so marker-like examples stay inert.
const mediaPlugin: NonNullable<SatteriMarkdownProcessorOptions['mdastPlugins']>[number] = (compile) => {
  const state = compile.data.astro?.frontmatter.__imcMedia as MediaState | undefined;
  if (!state) return null;
  return {
    name: 'imconnected-inline-photos',
    paragraph(node, ctx) {
      if (ctx.parent(node)?.type !== 'root') return;
      type Child = (typeof node.children)[number];
      const lines: Child[][] = [[]];
      for (const child of node.children) {
        if (child.type !== 'text') { lines.at(-1)!.push(child); continue; }
        child.value.split('\n').forEach((value, index) => { if (index) lines.push([]); if (value) lines.at(-1)!.push({ type: 'text', value }); });
      }
      if (!lines.some((line) => line.every((n) => n.type === 'text') && isMediaMarkerLine(line.map((n) => n.type === 'text' ? n.value : '').join('')))) return;
      const replacements: Parameters<typeof ctx.replaceNode>[1][] = [];
      let paragraph: Child[] = [];
      const flush = () => { if (paragraph.some((n) => n.type !== 'text' || n.value.trim())) replacements.push({ type: 'paragraph', children: paragraph }); paragraph = []; };
      for (const line of lines) {
        const value = line.every((n) => n.type === 'text') ? line.map((n) => n.type === 'text' ? n.value : '').join('').trim() : '';
        if (!isMediaMarkerLine(value)) { if (paragraph.length) paragraph.push({ type: 'text', value: '\n' }); paragraph.push(...line); continue; }
        flush();
        const index = photoMarkerIndex(value, state.photos.length);
        const photo = index === null ? undefined : state.photos[index];
        const html = photo ? renderInlinePhoto(photo, state.preview) : '';
        if (html && photo && index !== null) { state.used.add(index); replacements.push({ type: 'html', value: html }); }
        else {
          state.warnings.push(value);
          if (state.preview) replacements.push({ type: 'html', value: `<p class="story-media-warning" role="status">Photo marker skipped: ${escapeHtml(value)}. Choose a photo from this story.</p>` });
        }
      }
      flush();
      ctx.replaceNode(node, replacements.flat());
    },
  };
};
let processor: ReturnType<typeof createSatteriMarkdownProcessor> | undefined;
export async function renderMediaMarkdown(body: string, photos: InlineStoryPhoto[], preview = false): Promise<{ html: string; used: Set<number>; warnings: string[] }> {
  const state: MediaState = { photos, preview, used: new Set(), warnings: [] };
  if (!/^\s*\{\{\s*(?:photo|gallery)\b/m.test(body)) return { html: (await renderMarkdownSafe(body)).html, used: state.used, warnings: [] };
  const renderer = await (processor ??= createSatteriMarkdownProcessor({ mdastPlugins: [mediaPlugin] }));
  const { code } = await renderer.render(escapeHtmlInMarkdown(body), { frontmatter: { __imcMedia: state } });
  // Match the existing Markdown URL guard, including user-authored links/images.
  const { html } = checkMarkdownLinks(code);
  return { html, used: state.used, warnings: state.warnings };
}
