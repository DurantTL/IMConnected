// A plain-text excerpt of a story body, for Studio's list (GET /api/stories). Plain TypeScript, no imports.

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[k] ?? m;
  });
}

/** First non-empty paragraph of a Markdown body as plain text, at most `max` characters, cut at a word boundary with an ellipsis. */
export function storyExcerpt(body: string | undefined | null, max = 400): string {
  if (!body) return '';
  const paragraphs = body.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/);
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
    t = decodeEntities(t.replace(/<[^>]*>/g, '')).replace(/\\([\\`*_{}\[\]()#+\-.!<>&])/g, '$1').replace(/\s+/g, ' ').trim();
    if (!t || /^[-*_=\s]{3,}$/.test(t)) continue;
    if ([...t].length <= max) return t;
    const cut = [...t].slice(0, max).join('');
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
  }
  return '';
}
