import { markdownToMdast } from 'satteri';
import { escapeHtmlInMarkdown } from './storyfile';
import { parsePhotoMarker, galleryMarker } from './story-media';
interface Node { type: string; children?: Node[]; position?: { start: { line: number }; end: { line: number } } }
/** Rewrite only executable marker lines; code, links and escaped examples stay literal. */
export function restoreMediaMarkers(body: string, oldKeys: string[], currentKeys: string[]): { body: string; missing: boolean } {
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
      const trimmed = raw[line]?.trim() ?? '';
      // The renderer drops the backslash of an escaped marker line and still renders it, so it is remapped like any other (the backslash is kept).
      const escaped = trimmed.startsWith('\\{{');
      const value = escaped ? trimmed.slice(1) : trimmed;
      const lead = escaped ? '\\' : '';
      // The grammar is bounded independently of the old count: an old invalid index
      // must never become an executable marker for a newly added replacement photo.
      const marker = parsePhotoMarker(value, 999);
      const photo = marker?.index ?? null;
      const gallery = galleryMarker(value, 999);
      if (photo !== null) {
        const index = slot(photo);
        raw[line] = lead + (index < 0 ? '{{photo missing}}' : `{{photo ${index + 1}${marker?.placement ? ` ${marker.placement}` : ''}}}`);
        missing ||= index < 0;
      } else if (gallery) {
        const indices = gallery.indices.map(slot);
        const valid = indices.every((n, i) => n >= 0 && (i === 0 || n === indices[i - 1] + 1));
        raw[line] = lead + (valid ? `{{gallery ${indices[0] + 1}-${indices.at(-1)! + 1} columns=${gallery.columns}}}` : '{{gallery missing}}');
        missing ||= !valid;
      }
    }
  }
  return { body: raw.join('\n'), missing };
}
