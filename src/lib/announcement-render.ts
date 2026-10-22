import { normalizeAnnouncement, type Announcement } from './announcement';
import { escapeHtml } from './markdown';
import { renderStoryBlocksSafe } from './story-block-render';
/** Typed, escaped details used by the public article and script-disabled editor preview. */
export async function renderAnnouncementDetails(input: Announcement | null | undefined, preview = false): Promise<string> {
  const a = normalizeAnnouncement(input);
  if (!a) return '';
  const video = a.videoUrl ? await renderStoryBlocksSafe([{ id: 'announcement-video', type: 'video', url: a.videoUrl, label: 'Announcement video' }], { preview }) : '';
  return `<aside class="announcement-details" aria-label="${a.kind === 'event' ? 'Event' : 'Announcement'} details"><h2>${a.kind === 'event' ? 'Event details' : 'Announcement'}</h2>${a.eventDate ? `<p><strong>When:</strong> <time datetime="${escapeHtml(a.eventDate)}">${escapeHtml(a.eventDate)}</time></p>` : ''}${a.location ? `<p><strong>Where:</strong> ${escapeHtml(a.location)}</p>` : ''}${a.links.length ? `<div class="announcement-actions">${a.links.map((link) => `<a class="btn" href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`).join('')}</div>` : ''}${video}</aside>`;
}
