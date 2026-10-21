// Server-only module rendering. Keep the shared schema usable in the editor without pulling Markdown into its bundle.
import { escapeHtml, renderMarkdownSafe } from './markdown';
import { focalPoint, isStoryImageUrl, normalizeStoryBlocks, type StoryBlock } from './story-blocks';

export interface StoryBlockRenderOptions {
  /** The authenticated editor can resolve an image's draft photo ID without exposing it publicly. */
  resolvePhoto?: (photoId: number) => { url: string; alt?: string; focalX?: number; focalY?: number } | undefined;
}

export async function renderStoryBlocksSafe(input: StoryBlock[], options: StoryBlockRenderOptions = {}): Promise<string> {
  const blocks = normalizeStoryBlocks(input);
  const out: string[] = [];
  for (const b of blocks) {
    const attr = ` data-module-id="${escapeHtml(b.id)}"`;
    switch (b.type) {
      case 'text': out.push(`<div class="story-module story-module-text"${attr}>${(await renderMarkdownSafe(b.text || '')).html}</div>`); break;
      case 'heading': out.push(`<h${b.level || 2} class="story-module"${attr}>${escapeHtml(b.text || '')}</h${b.level || 2}>`); break;
      case 'quote': out.push(`<blockquote class="story-module"${attr}>${(await renderMarkdownSafe(b.text || '')).html}</blockquote>`); break;
      case 'list': out.push(`<ul class="story-module"${attr}>${(b.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`); break;
      case 'divider': out.push(`<hr class="story-module"${attr}>`); break;
      case 'button':
        if (b.url) out.push(`<p class="story-module story-module-action"${attr}><a class="btn" href="${escapeHtml(b.url)}">${escapeHtml(b.label || b.url)}</a></p>`);
        break;
      case 'image': {
        const photo = b.photoId ? options.resolvePhoto?.(b.photoId) : undefined;
        const url = photo?.url || b.url || '';
        // Only the trusted callback can return a protected editor photo endpoint.
        if (!isStoryImageUrl(url) && !(photo && /^\/api\/admin\/photos\/\d+$/.test(url))) break;
        const x = focalPoint(photo?.focalX ?? b.focalX), y = focalPoint(photo?.focalY ?? b.focalY);
        const alt = b.alt || photo?.alt || '';
        const linkLabel = alt.trim() ? '' : ' aria-label="Enlarge story photo"';
        out.push(`<figure class="story-module story-module-image"${attr}><a href="${escapeHtml(url)}" data-photo${linkLabel}><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" style="width:100%;aspect-ratio:16/9;object-fit:cover;object-position:${x}% ${y}%;"></a></figure>`);
        break;
      }
    }
  }
  return out.join('\n');
}
