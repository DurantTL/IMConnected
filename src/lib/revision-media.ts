import { markdownToMdast } from 'satteri';
import { escapeHtmlInMarkdown } from './storyfile';
import { parsePhotoMarker, galleryMarker } from './story-media';
interface Node { type: string; children?: Node[]; position?: { start: { line: number }; end: { line: number } } }
/** Rewrite only executable marker lines; code, links and escaped examples stay literal. */
export function restoreMediaMarkers(body: string, oldKeys: string[], currentKeys: string[], options: { reorder?: boolean } = {}): { body: string; missing: boolean } {
  // reorder: the photos are all still the story's own (a reorder or delete), so a marker whose number was never a photo stays exactly as
  // written, and a gallery follows its photos as a set (see below). Restoring an older revision keeps the stricter original behaviour.
  const reorder = !!options.reorder;
  const raw = body.replace(/\r\n?/g, '\n').split('\n');
  const tree = markdownToMdast(escapeHtmlInMarkdown(body), { position: true }) as Node;
  let missing = false;
  const slot = (old: number): number => oldKeys[old] ? currentKeys.indexOf(oldKeys[old]) : -1;
  for (const paragraph of tree.children ?? []) {
    if (paragraph.type !== 'paragraph') continue;
    const textLines = new Set<number>(), blocked = new Set<number>();
    for (const child of paragraph.children ?? []) {
      if (!child.position) continue;
      const target = child.type === 'text' ? textLines : blocked;
      for (let line = child.position.start.line - 1; line < child.position.end.line; line++) target.add(line);
    }
    for (const line of textLines) {
      if (blocked.has(line)) continue;
      const value = raw[line]?.trim() ?? ''; // an escaped marker (\{{photo 1}}) is a literal example: it never matches and stays untouched
      // The grammar is bounded independently of the old count: an old invalid index
      // must never become an executable marker for a newly added replacement photo.
      const marker = parsePhotoMarker(value, 999);
      const photo = marker?.index ?? null;
      const gallery = galleryMarker(value, 999);
      if (reorder && ((photo !== null && photo >= oldKeys.length) || (gallery && gallery.indices.some((n) => n >= oldKeys.length)))) continue;
      if (photo !== null) {
        const index = slot(photo);
        raw[line] = index < 0 ? '{{photo missing}}' : `{{photo ${index + 1}${marker?.placement ? ` ${marker.placement}` : ''}}}`;
        missing ||= index < 0;
      } else if (gallery && reorder) {
        const present = gallery.indices.map(slot).filter((n) => n >= 0).sort((a, b) => a - b);
        // Longest run of consecutive positions: all of them, or all but one photo that moved away or was deleted.
        let best: number[] = [], run: number[] = [];
        for (const n of present) { run = run.length && n === run.at(-1)! + 1 ? [...run, n] : [n]; if (run.length > best.length) best = run; }
        if (best.length >= 2 && best.length >= gallery.indices.length - 1) {
          raw[line] = `{{gallery ${best[0] + 1}-${best.at(-1)! + 1} columns=${gallery.columns}}}`;
          missing ||= best.length < gallery.indices.length;
        } else { raw[line] = '{{gallery missing}}'; missing = true; }
      } else if (gallery) {
        const indices = gallery.indices.map(slot);
        const valid = indices.every((n, i) => n >= 0 && (i === 0 || n === indices[i - 1] + 1));
        raw[line] = valid ? `{{gallery ${indices[0] + 1}-${indices.at(-1)! + 1} columns=${gallery.columns}}}` : '{{gallery missing}}';
        missing ||= !valid;
      }
    }
  }
  return { body: raw.join('\n'), missing };
}
