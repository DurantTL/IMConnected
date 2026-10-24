// Pure position maths for dragging story modules (issue #151): where a dragged module may land, what an insert or a move
// produces, and the refusals. No DOM, so the rules are unit-testable (scripts/test-block-drop.mjs); the pointer handling is
// in src/scripts/block-drag.ts. Ported from the registration builder's field-drop.ts / palette-insert.ts. Every result is
// built with the story-blocks helpers, so the 60-node limit, the no-nesting rule and the 20,000-character limit are the
// same ones "+ Add", Move and Save already apply.
import { STORY_BLOCK_LIMIT, checkStoryBlockLength, countStoryBlocks, findStoryBlockLocation, walkStoryBlocks, type StoryBlock } from './story-blocks.ts';

/** A place between modules: the top level (`parentId` null) or one column of a Section; `index` counts the list as it is now. */
export interface DropSlot { parentId: string | null; column: number; index: number }
export type DropPlan =
  | { kind: 'ok'; blocks: StoryBlock[]; id: string; slot: DropSlot; position: number }
  | { kind: 'nothing' }
  | { kind: 'error'; message: string };

export const DRAG_THRESHOLD_PX = 6;
export const LONG_PRESS_MS = 250;
export const AUTOSCROLL_EDGE_PX = 64;
export const AUTOSCROLL_MAX_PX = 22;

export const NEST_MESSAGE = 'Sections cannot be nested. Drop the section outside another section.';
export const PLACEMENT_MESSAGE = 'Size and alignment is not available for photos inside a section. Place the photo outside the section.';
export const LIMIT_MESSAGE = `A story can have up to ${STORY_BLOCK_LIMIT} modules.`;
export const SECTION_SPACE_MESSAGE = 'A two-column section needs three module spaces.';

const clone = (blocks: StoryBlock[]) => JSON.parse(JSON.stringify(blocks)) as StoryBlock[];

/** The list a slot points into, or undefined when the section or column is gone. */
function listFor(blocks: StoryBlock[], slot: DropSlot): StoryBlock[] | undefined {
  if (slot.parentId === null) return blocks;
  const section = blocks.find((b) => b.id === slot.parentId && b.type === 'section');
  return section?.content?.[slot.column];
}

/** Refusals that depend only on what is dropped where (nesting, photo placement); null when allowed. */
export function slotRefusal(block: StoryBlock, slot: DropSlot): string | null {
  if (slot.parentId === null) return null;
  if (block.type === 'section') return NEST_MESSAGE;
  if (block.type === 'image' && block.placement) return PLACEMENT_MESSAGE;
  return null;
}

function finish(blocks: StoryBlock[], id: string, slot: DropSlot): DropPlan {
  try { checkStoryBlockLength(blocks); } catch (e) { return { kind: 'error', message: e instanceof Error ? e.message : 'Check the module text first.' }; }
  return { kind: 'ok', blocks, id, slot, position: walkStoryBlocks(blocks).findIndex((b) => b.id === id) + 1 };
}

/** Drop a NEW module (already built by the same factory "+ Add" uses) at a slot. Same limits and messages as "+ Add". */
export function planInsert(blocks: StoryBlock[], block: StoryBlock, slot: DropSlot): DropPlan {
  if (countStoryBlocks(blocks) >= STORY_BLOCK_LIMIT) return { kind: 'error', message: LIMIT_MESSAGE };
  if (block.type === 'section' && countStoryBlocks(blocks) + 3 > STORY_BLOCK_LIMIT) return { kind: 'error', message: SECTION_SPACE_MESSAGE };
  const refusal = slotRefusal(block, slot);
  if (refusal) return { kind: 'error', message: refusal };
  const next = clone(blocks);
  const list = listFor(next, slot);
  if (!list) return { kind: 'nothing' };
  list.splice(Math.min(Math.max(slot.index, 0), list.length), 0, block);
  return finish(next, block.id, slot);
}

/**
 * Move an existing module to a slot. `slot.index` is in the list as it is before the move (the dragged module goes in front of
 * the module that was at that index; the length means the end), so moving down inside one list lands one place earlier than
 * the raw index. Dropping where it already is changes nothing.
 */
export function planMove(blocks: StoryBlock[], id: string, slot: DropSlot): DropPlan {
  const from = findStoryBlockLocation(blocks, id);
  if (!from) return { kind: 'nothing' };
  const block = from.siblings[from.index];
  const refusal = slotRefusal(block, slot);
  if (refusal) return { kind: 'error', message: refusal };
  const next = clone(blocks);
  const source = findStoryBlockLocation(next, id)!;
  const target = listFor(next, slot);
  if (!target) return { kind: 'nothing' };
  const sameList = source.siblings === target;
  const raw = Math.min(Math.max(slot.index, 0), target.length);
  const insertAt = sameList && source.index < raw ? raw - 1 : raw;
  if (sameList && insertAt === source.index) return { kind: 'nothing' };
  const [moved] = source.siblings.splice(source.index, 1);
  target.splice(insertAt, 0, moved);
  return finish(next, id, { ...slot, index: insertAt });
}

/** What the pointer is closest to: candidates carry the page-space y of their line (and x of its left end). */
export interface SlotCandidate { slot: DropSlot; y: number; x: number }
/** The nearest line vertically; a tie (a section's last column and the slot after the section share a y) goes to the one whose left end is nearer the pointer. */
export function pickSlot<T extends SlotCandidate>(candidates: readonly T[], x: number, y: number): T | null {
  let best: T | null = null, bestScore = Infinity;
  for (const c of candidates) {
    const score = Math.abs(c.y - y) + Math.abs(c.x - x) * 0.02;
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** Pixels to scroll the page per frame while dragging: negative near the top of the window, positive near the bottom, 0 elsewhere. */
export function autoScrollDelta(clientY: number, viewportHeight: number, edge = AUTOSCROLL_EDGE_PX, max = AUTOSCROLL_MAX_PX): number {
  if (clientY < edge) return -Math.ceil(max * Math.min(1, (edge - clientY) / edge));
  if (clientY > viewportHeight - edge) return Math.ceil(max * Math.min(1, (clientY - (viewportHeight - edge)) / edge));
  return 0;
}

export const movedBeyondThreshold = (dx: number, dy: number, threshold = DRAG_THRESHOLD_PX) => Math.hypot(dx, dy) >= threshold;

/** Spoken after a completed drop, e.g. "Paragraph added after Quote" or "Image moved to position 3". */
export function describeDrop(plan: Extract<DropPlan, { kind: 'ok' }>, label: (b: StoryBlock) => string, added: boolean): string {
  const block = walkStoryBlocks(plan.blocks).find((b) => b.id === plan.id)!;
  if (!added) return `${label(block)} moved to position ${plan.position}.`;
  const list = listFor(plan.blocks, plan.slot) ?? [];
  const before = list[plan.slot.index - 1];
  const section = plan.slot.parentId === null ? undefined : plan.blocks.find((b) => b.id === plan.slot.parentId);
  const where = before ? `after ${label(before)}` : section ? `at the start of column ${plan.slot.column + 1} in ${label(section)}` : 'at the top';
  return `${label(block)} added ${where}.`;
}
