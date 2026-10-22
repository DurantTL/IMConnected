// A plain-text excerpt of a story body, for Studio's list (GET /api/stories).
import { stripMediaMarkers } from './story-media';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Control characters (except tab, newline, carriage return), surrogates and bidirectional overrides are never wanted in text. */
function okCodePoint(n: number): boolean {
  if (n === 9 || n === 10 || n === 13) return true;
  if (n < 0x20 || (n >= 0x7f && n <= 0x9f) || (n >= 0xd800 && n <= 0xdfff)) return false;
  if ((n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069)) return false;
  return true;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      if (!Number.isFinite(n) || n > 0x10ffff || !okCodePoint(n)) return n === 9 || n === 10 || n === 13 ? ' ' : '';
      return String.fromCodePoint(n);
    }
    return ENTITIES[k] ?? m;
  });
}

/** First non-empty paragraph of a Markdown body as plain text, at most `max` characters, cut at a word boundary with an ellipsis. */
export function storyExcerpt(body: string | undefined | null, max = 400): string {
  if (!body) return '';
  const paragraphs = stripMediaMarkers(body).replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/);
  for (const raw of paragraphs) {
    // A heading on its own is a title, not the story's first paragraph.
    if (raw.split('\n').every((l) => !l.trim() || /^\s{0,3}#{1,6}(\s|$)/.test(l))) continue;
    let t = raw
      .split('\n')
      .map((l) => l.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)+/, ''))
      .join(' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|\*|_|~~)/g, '');
    // Strip tags, decode entities, then remove every < and > (a decoded &lt;img ...&gt; must never become a tag), and any control characters.
    t = decodeEntities(t.replace(/<[^>]*>/g, '')).replace(/\\([\\`*_{}\[\]()#+\-.!<>&])/g, '$1').replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
    if (!t || /^[-*_=\s]{3,}$/.test(t)) continue;
    if ([...t].length <= max) return t;
    const cut = [...t].slice(0, max - 1).join('');
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
  }
  return '';
}
