// RSS 2.0 feed of the newest stories. Prerendered at build time.
import type { APIRoute } from 'astro';
import { getFeedItems } from '../lib/feed';
import { SITE } from '../lib/site';

// Strips characters XML 1.0 forbids (one stray control character would break the whole feed), then escapes.
const xml = (v: string) =>
  v
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('https://stories.imsda.org');
  const items = await getFeedItems(base);
  const entries = items.map((s) => {
    const category = s.areaLabel ? `${s.sectionLabel} / ${s.areaLabel}` : s.sectionLabel;
    return [
      '    <item>',
      `      <title>${xml(s.title)}</title>`,
      `      <link>${xml(s.url)}</link>`,
      `      <guid isPermaLink="true">${xml(s.url)}</guid>`,
      `      <pubDate>${new Date(`${s.date}T12:00:00Z`).toUTCString()}</pubDate>`,
      `      <dc:creator>${xml(s.author)}</dc:creator>`,
      `      <category>${xml(category)}</category>`,
      ...(s.dek ? [`      <description>${xml(s.dek)}</description>`] : []),
      ...(s.image
        ? [`      <media:content url="${xml(s.image)}" medium="image">${s.imageAlt ? `<media:description>${xml(s.imageAlt)}</media:description>` : ''}</media:content>`]
        : []),
      '    </item>',
    ].join('\n');
  });

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
    '  <channel>',
    `    <title>${xml(SITE.name)}</title>`,
    `    <link>${xml(base.href)}</link>`,
    `    <description>${xml(SITE.description)}</description>`,
    '    <language>en-us</language>',
    `    <atom:link href="${xml(new URL('/rss.xml', base).href)}" rel="self" type="application/rss+xml" />`,
    ...entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
