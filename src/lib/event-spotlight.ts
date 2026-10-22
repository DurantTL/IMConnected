import type { PublicStory } from './stories';
export function conferenceDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type)!.value).join('-');
}
/** Public list supplied by the database reader; a flyer is never cropped to fill the rail. */
export function upcomingEvents(stories: PublicStory[], today = conferenceDay()): PublicStory[] {
  return stories.filter((s) => s.data.announcement?.kind === 'event' && (!s.data.announcement.eventDate || s.data.announcement.eventDate >= today))
    .sort((a, b) => (a.data.announcement!.eventDate || '9999').localeCompare(b.data.announcement!.eventDate || '9999') || a.id.localeCompare(b.id)).slice(0, 6);
}
