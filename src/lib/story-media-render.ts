import { createSatteriMarkdownProcessor, type SatteriMarkdownProcessorOptions } from '@astrojs/markdown-satteri';
import { escapeHtml, checkMarkdownLinks, renderMarkdownSafe } from './markdown';
import { escapeHtmlInMarkdown } from './storyfile';
import { photoFocusStyle, photoFrameHtml, isStoryImageUrl } from './story-blocks';
import { parsePhotoMarker, galleryMarker, type PhotoPlacement, isMediaMarkerLine, type InlineStoryPhoto } from './story-media';

export const INLINE_MEDIA_CSS = '.story-module[data-align=left]{text-align:left}.story-module[data-align=center]{text-align:center}.story-module[data-align=right]{text-align:right}.story-module[data-module-id][data-spacing=compact]{margin-block:12px}.story-module[data-module-id][data-spacing=normal]{margin-block:24px}.story-module[data-module-id][data-spacing=relaxed]{margin-block:40px}.story-section{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;margin-block:24px}.story-section-column{min-width:0}.story-section-column>:first-child{margin-top:0}@media(min-width:768px){.story-section[data-columns="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}}.story-video-player{background:#eef3f3;padding:24px;border-radius:8px;font:15px/1.5 system-ui}.story-video-player iframe{display:block;width:100%;aspect-ratio:16/9;border:0}.story-flyer img{height:auto;aspect-ratio:auto;object-fit:contain}.announcement-details{padding:20px;border:1px solid #cad5d5;border-radius:8px;margin:24px 0}.announcement-actions{display:flex;flex-wrap:wrap;gap:12px}.story-inline-gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:1.4em 0}.story-inline-gallery figure{margin:0;min-width:0}@media(min-width:768px){.story-inline-gallery[data-columns="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}}.story-inline-photo{margin:1.4em 0}.story-inline-photo a{display:block;overflow:hidden;border-radius:8px}.story-inline-photo img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover;margin:0}.story-inline-photo .photo-caption,.story-module-image .photo-caption{margin:8px 0 0;font-size:.82rem;line-height:1.4;color:#4a5560;overflow-wrap:anywhere}[data-fit=contain]{position:relative;isolation:isolate;overflow:hidden}[data-fit=contain][data-fit-fill=paper]{background:var(--bg,#F8F7F5)}[data-fit=contain][data-fit-fill=navy]{background:#0B3954}[data-fit=contain][data-fit-fill=blur]{background:#0B3954}[data-fit=contain][data-fit-fill=blur]::before{content:"";position:absolute;inset:-12%;z-index:-1;background:var(--fit-src) center/cover no-repeat;filter:blur(24px) saturate(1.1);pointer-events:none}[data-fit=contain] img{display:block;width:100%!important;height:100%!important;aspect-ratio:auto!important;object-fit:contain!important;object-position:50% 50%!important;scale:none!important;transform:none!important}.story-inline-photo[data-placement],.story-module-image[data-placement]{clear:both}.story-inline-photo[data-placement=wide],.story-module-image[data-placement=wide]{position:relative;left:50%;transform:translateX(-50%);width:min(960px,calc(100vw - 32px));max-width:none}.story-inline-photo[data-placement=full],.story-module-image[data-placement=full]{position:relative;left:50%;transform:translateX(-50%);width:min(1400px,calc(100vw - 32px));max-width:none}.story-inline-photo[data-placement=full] a,.story-module-image[data-placement=full] a{border-radius:0!important}@media(min-width:768px){.story-inline-photo[data-placement=left],.story-module-image[data-placement=left]{float:left;clear:left;width:45%;margin:.3em 1.5em 1em 0}.story-inline-photo[data-placement=right],.story-module-image[data-placement=right]{float:right;clear:right;width:45%;margin:.3em 0 1em 1.5em}}.story-inline-photo:not([data-placement]),.story-inline-gallery,.story-module-image:not([data-placement]){clear:both}.prose h2,.prose h3{clear:both}.prose :is(ul,ol,blockquote,pre,hr),.story-module-video,.announcement-details{display:flow-root}.prose::after{content:"";display:block;clear:both}html{overflow-x:clip}.story-section-column .story-module-image[data-placement]{position:static;left:auto;transform:none;width:auto;max-width:100%;float:none;clear:none;margin-inline:0}.story-media-warning{padding:12px;border:1px solid #a54b10;background:#fff4df;color:#6b3009}';
interface MediaState { photos: InlineStoryPhoto[]; preview: boolean; used: Set<number>; warnings: string[]; flyerIndex?: number }

/** The caption under an inline photo: plain text, stored raw and escaped here; never Markdown or HTML; empty = nothing. */
export const captionHtml = (caption?: string): string => { const text = (caption ?? '').trim(); return text ? `<figcaption class="photo-caption">${escapeHtml(text)}</figcaption>` : ''; };

export function renderInlinePhoto(photo: InlineStoryPhoto, preview = false, flyer = false, placement?: PhotoPlacement): string {
  let allowed = isStoryImageUrl(photo.src) || preview && /^\/api\/admin\/photos\/\d+$/.test(photo.src);
  try { const url = new URL(photo.src); allowed ||= url.protocol === 'https:' && !url.username && !url.password && !/[\s<>"']/.test(photo.src); } catch { /* relative own-story URLs above */ }
  if (!allowed) return '';
  const alt = photo.alt.replace(/&lt;/g, '<');
  return `<figure class="story-inline-photo${flyer ? ' story-flyer' : ''}"${placement ? ` data-placement="${placement}"` : ''}><a href="${escapeHtml(photo.src)}" data-photo${alt.trim() ? '' : ' aria-label="Enlarge story photo"'}${flyer ? '' : photoFrameHtml(photo, photo.src, '16/9')}><img src="${escapeHtml(photo.src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" style="${flyer ? 'aspect-ratio:auto;object-fit:contain;' : photoFocusStyle(photo) ?? ''}"></a>${captionHtml(photo.caption)}</figure>`;
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
        const marker = parsePhotoMarker(value, state.photos.length);
        const index = marker?.index ?? null;
        const photo = index === null ? undefined : state.photos[index];
        const gallery = galleryMarker(value, state.photos.length);
        let html = photo ? renderInlinePhoto(photo, state.preview, index === state.flyerIndex, marker?.placement) : '';
        if (gallery) {
          const images = gallery.indices.map((i) => renderInlinePhoto(state.photos[i], state.preview, i === state.flyerIndex));
          if (images.every(Boolean)) html = `<section class="story-inline-gallery" data-columns="${gallery.columns}" aria-label="Story photo gallery">${images.join('')}</section>`;
        }
        if (html) { if (gallery) gallery.indices.forEach((i) => state.used.add(i)); else if (index !== null) state.used.add(index); replacements.push({ type: 'html', value: html }); }
        else {
          state.warnings.push(value);
          if (state.preview) replacements.push({ type: 'html', value: `<p class="story-media-warning" role="status">Media marker skipped: ${escapeHtml(value)}. Choose a photo from this story.</p>` });
        }
      }
      flush();
      ctx.replaceNode(node, replacements.flat());
    },
  };
};
let processor: ReturnType<typeof createSatteriMarkdownProcessor> | undefined;
export async function renderMediaMarkdown(body: string, photos: InlineStoryPhoto[], preview = false, flyerIndex?: number): Promise<{ html: string; used: Set<number>; warnings: string[] }> {
  const state: MediaState = { photos, preview, flyerIndex, used: new Set(), warnings: [] };
  if (!/^\s*\{\{\s*(?:photo|gallery)\b/m.test(body)) return { html: (await renderMarkdownSafe(body)).html, used: state.used, warnings: [] };
  const renderer = await (processor ??= createSatteriMarkdownProcessor({ mdastPlugins: [mediaPlugin] }));
  const { code } = await renderer.render(escapeHtmlInMarkdown(body), { frontmatter: { __imcMedia: state } });
  // Match the existing Markdown URL guard, including user-authored links/images.
  const { html } = checkMarkdownLinks(code);
  return { html, used: state.used, warnings: state.warnings };
}
