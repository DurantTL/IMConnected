// Typed bulletin metadata. No HTML, embeds, remote fetches or draft photo IDs.
import { isStoryButtonUrl, parseStoryVideo } from './story-blocks.ts';
export interface Announcement {
  kind: 'announcement' | 'event';
  eventDate?: string;
  location?: string;
  links: { label: string; url: string }[];
  videoUrl?: string;
}
export function normalizeAnnouncement(value: unknown): Announcement | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Announcement must be an object or null.');
  const r = value as Record<string, unknown>;
  if (r.kind !== 'announcement' && r.kind !== 'event') throw new Error('Choose announcement or event.');
  const text = (v: unknown, max: number, label: string) => {
    if (v === undefined || v === '') return '';
    if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${label} is invalid or too long.`);
    return v.trim();
  };
  const eventDate = text(r.eventDate, 10, 'Event date');
  if (eventDate && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(Date.parse(eventDate)) || new Date(eventDate).toISOString().slice(0, 10) !== eventDate)) throw new Error('Event date must be a real YYYY-MM-DD date.');
  const location = text(r.location, 200, 'Location');
  if (r.links !== undefined && (!Array.isArray(r.links) || r.links.length > 3)) throw new Error('An announcement can have up to three links.');
  const links = ((r.links ?? []) as unknown[]).map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each link needs a label and address.');
    const link = raw as Record<string, unknown>;
    const label = text(link.label, 120, 'Link label'), url = text(link.url, 2048, 'Link address');
    if (!label || !url || !isStoryButtonUrl(url)) throw new Error('Each link needs a label and a safe web, mailto or tel address.');
    return { label, url };
  });
  const rawVideo = text(r.videoUrl, 2048, 'Video URL');
  const video = rawVideo ? parseStoryVideo(rawVideo) : null;
  if (rawVideo && !video) throw new Error('Use a supported HTTPS YouTube or Vimeo video URL.');
  return { kind: r.kind, ...(eventDate ? { eventDate } : {}), ...(location ? { location } : {}), links, ...(video ? { videoUrl: video.url } : {}) };
}
/**
 * Agent patch semantics: a partial object merged into the stored announcement, then validated as a whole by
 * normalizeAnnouncement. A key that is present replaces that field ("" clears an optional text field, `links` replaces the
 * whole list); an omitted key keeps the stored value. `kind` is required only when there is nothing stored to merge into.
 */
export function mergeAnnouncement(current: Announcement | null, patch: Record<string, unknown>): Announcement {
  if (!current && patch.kind === undefined) throw new Error('Choose announcement or event: kind is required when there is no announcement yet.');
  const sent = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return normalizeAnnouncement({ ...(current ?? {}), ...sent }) as Announcement;
}
export function parseAnnouncement(value: unknown): Announcement | null {
  if (typeof value !== 'string') return normalizeAnnouncement(value);
  if (value.length > 12_000) throw new Error('Announcement data is too large.');
  try { return normalizeAnnouncement(JSON.parse(value)); } catch (e) {
    if (e instanceof SyntaxError) throw new Error('Announcement data could not be read.');
    throw e;
  }
}
export const announcementJson = (value: unknown): string | null => {
  const parsed = normalizeAnnouncement(value);
  return parsed ? JSON.stringify(parsed) : null;
};
