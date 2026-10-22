import { getDb } from './db';
import { normalizeStoryBlocks, mapStoryBlocks, countStoryBlocks, type StoryBlock } from './story-blocks';
/** Structures contain settings and kinds only: no copied prose, links, alt text or media identities. */
export function storyLayoutStructure(input: unknown): StoryBlock[] {
  const blocks = normalizeStoryBlocks(input);
  if (!countStoryBlocks(blocks)) throw new Error('Add modules before saving a layout.');
  let id = 0;
  return mapStoryBlocks(blocks, (b) => ({
    id: `layout-${++id}`, type: b.type,
    ...(b.align ? { align: b.align } : {}), ...(b.spacing ? { spacing: b.spacing } : {}),
    ...(b.type === 'section' ? { content: b.content } : {}),
    ...(b.type === 'heading' ? { level: b.level ?? 2, text: '' } : {}),
    ...(['text', 'quote'].includes(b.type) ? { text: '' } : {}),
    ...(b.type === 'list' ? { items: [''] } : {}),
    ...(b.type === 'gallery' ? { columns: b.columns ?? 2, photos: [] } : {}),
    ...(['button', 'video'].includes(b.type) ? { label: '', url: '' } : {}),
  }));
}
export function listEditorLayouts(userId: number): { id: number; name: string; blocks: StoryBlock[] }[] {
  return (getDb().prepare('SELECT id, name, blocks FROM editor_layouts WHERE user_id=? ORDER BY id DESC LIMIT 50').all(userId) as { id: number; name: string; blocks: string }[]).map((r) => ({ id: r.id, name: r.name, blocks: normalizeStoryBlocks(JSON.parse(r.blocks)) }));
}
export function saveEditorLayout(userId: number, name: unknown, input: unknown): number {
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Name the layout using up to 80 characters.');
  const blocks = storyLayoutStructure(input), db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const count = Number((db.prepare('SELECT COUNT(*) n FROM editor_layouts WHERE user_id=?').get(userId) as { n: number }).n);
    if (count >= 50) throw new Error('You can save up to 50 layouts. Delete one before adding another.');
    const id = Number(db.prepare('INSERT INTO editor_layouts(user_id,name,blocks,created_at) VALUES(?,?,?,?)').run(userId, name.trim(), JSON.stringify(blocks), Date.now()).lastInsertRowid);
    db.exec('COMMIT'); return id;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
export const deleteEditorLayout = (userId: number, id: number): boolean => Number(getDb().prepare('DELETE FROM editor_layouts WHERE user_id=? AND id=?').run(userId, id).changes) === 1;
