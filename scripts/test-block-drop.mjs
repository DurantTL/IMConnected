#!/usr/bin/env node
// Unit tests for the pure drag-and-drop rules of the story module builder (src/lib/block-drop.ts, issue #151). No server, no browser.
// node scripts/test-block-drop.mjs
import assert from 'node:assert/strict';
import { autoScrollDelta, describeDrop, movedBeyondThreshold, pickSlot, planInsert, planMove, slotRefusal, LIMIT_MESSAGE, NEST_MESSAGE, PLACEMENT_MESSAGE, SECTION_SPACE_MESSAGE } from '../src/lib/block-drop.ts';
import { normalizeStoryBlocks } from '../src/lib/story-blocks.ts';

let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
const text = (id, value = id) => ({ id, type: 'text', text: value });
const root = (index) => ({ parentId: null, column: 0, index });
const ids = (blocks) => blocks.map((b) => b.id).join();
const labels = { text: 'Paragraph', heading: 'Heading', image: 'Image', section: 'Section / columns' };
const label = (b) => labels[b.type] ?? b.type;
const base = [text('a'), text('b'), text('c')];
const section = { id: 's', type: 'section', content: [[text('s1')], []] };

// insert
let plan = planInsert(base, text('n'), root(0));
check('insert at the top', plan.kind === 'ok' && ids(plan.blocks) === 'n,a,b,c' && plan.position === 1 && base.length === 3);
plan = planInsert(base, text('n'), root(2));
check('insert between modules', plan.kind === 'ok' && ids(plan.blocks) === 'a,b,n,c' && plan.position === 3);
plan = planInsert(base, text('n'), root(3));
check('insert at the end', plan.kind === 'ok' && ids(plan.blocks) === 'a,b,c,n');
plan = planInsert(base, text('n'), root(99));
check('an index past the end is clamped to the end (the reported slot too)', plan.kind === 'ok' && ids(plan.blocks) === 'a,b,c,n' && plan.slot.index === 3);
plan = planInsert([text('a'), section], text('n'), { parentId: 's', column: 1, index: 0 });
check('insert into an empty Section column', plan.kind === 'ok' && plan.blocks[1].content[1][0].id === 'n' && plan.position === 4);
plan = planInsert([text('a'), section], text('n'), { parentId: 'gone', column: 0, index: 0 });
check('a slot in a Section that no longer exists changes nothing', plan.kind === 'nothing');
check('every produced list passes the server normalizer', (() => { const p = planInsert([text('a'), section], text('n'), { parentId: 's', column: 0, index: 1 }); normalizeStoryBlocks(p.blocks); return true; })());

// refusals
plan = planInsert([text('a'), section], { id: 'n', type: 'section', content: [[text('n1')], [text('n2')]] }, { parentId: 's', column: 0, index: 0 });
check('a section cannot be dropped into a section column', plan.kind === 'error' && plan.message === NEST_MESSAGE);
plan = planMove([text('a'), section], 's', { parentId: 's', column: 0, index: 0 });
check('a section cannot be moved into itself', plan.kind === 'error' && plan.message === NEST_MESSAGE);
const image = { id: 'img', type: 'image', photoId: 1, alt: 'Synthetic', placement: 'wide' };
plan = planMove([image, section], 'img', { parentId: 's', column: 0, index: 0 });
check('an image with a placement is refused inside a section', plan.kind === 'error' && plan.message === PLACEMENT_MESSAGE);
check('an image without a placement is allowed inside a section', planMove([{ ...image, placement: undefined }, section], 'img', { parentId: 's', column: 0, index: 0 }).kind === 'ok');
check('slotRefusal allows the top level for everything', slotRefusal(image, root(0)) === null && slotRefusal({ id: 'x', type: 'section', content: [[]] }, root(0)) === null);
const sixty = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, type: 'divider' }));
plan = planInsert(sixty, text('n'), root(0));
check('a drop over 60 modules is refused with the + Add message', plan.kind === 'error' && plan.message === LIMIT_MESSAGE);
plan = planInsert(sixty.slice(0, 58), { id: 'n', type: 'section', content: [[text('n1')], [text('n2')]] }, root(0));
check('a section needs three spaces', plan.kind === 'error' && plan.message === SECTION_SPACE_MESSAGE);
plan = planMove(sixty, 'd5', root(0));
check('moving at 60 modules is fine (the count does not change)', plan.kind === 'ok' && plan.blocks.length === 60);
plan = planInsert([text('big', 'x'.repeat(19_990))], text('n', 'y'.repeat(30)), root(1));
check('the 20,000-character limit is checked on the result, with its existing message', plan.kind === 'error' && plan.message.includes('20,000'));

// move
plan = planMove(base, 'c', root(0));
check('move to the top', plan.kind === 'ok' && ids(plan.blocks) === 'c,a,b' && plan.position === 1);
plan = planMove(base, 'a', root(3));
check('move to the end (the index counts the list before the move)', plan.kind === 'ok' && ids(plan.blocks) === 'b,c,a');
plan = planMove(base, 'a', root(2));
check('moving down lands in front of the module at that index', plan.kind === 'ok' && ids(plan.blocks) === 'b,a,c');
check('dropping where it already is changes nothing (before itself and right after itself)', planMove(base, 'b', root(1)).kind === 'nothing' && planMove(base, 'b', root(2)).kind === 'nothing');
plan = planMove([text('a'), section], 's1', root(0));
check('a module leaves a section column for the top level', plan.kind === 'ok' && ids(plan.blocks) === 's1,a,s' && plan.blocks[2].content[0].length === 0);
plan = planMove([text('a'), section], 'a', { parentId: 's', column: 1, index: 0 });
check('a top-level module moves into the other column', plan.kind === 'ok' && plan.blocks[0].content[1][0].id === 'a' && ids(plan.blocks) === 's');
plan = planMove([{ id: 's', type: 'section', content: [[text('x'), text('y')], [text('z')]] }], 'x', { parentId: 's', column: 0, index: 2 });
check('moving down inside one column', plan.kind === 'ok' && plan.blocks[0].content[0].map((b) => b.id).join() === 'y,x');
check('moving an unknown module changes nothing', planMove(base, 'nope', root(0)).kind === 'nothing');
check('a plan never mutates its input', JSON.stringify(base) === JSON.stringify([text('a'), text('b'), text('c')]));

// announcements
plan = planInsert(base, text('n'), root(0));
check('announcement at the top', describeDrop(plan, label, true) === 'Paragraph added at the top.');
plan = planInsert([{ id: 'q', type: 'quote', text: '' }, ...base], { id: 'n', type: 'heading', text: '' }, root(1));
check('announcement after a module', describeDrop(plan, (b) => ({ quote: 'Quote', heading: 'Heading' })[b.type] ?? 'Paragraph', true) === 'Heading added after Quote.');
plan = planInsert([text('a'), section], text('n'), { parentId: 's', column: 1, index: 0 });
check('announcement at the start of a column', describeDrop(plan, label, true) === 'Paragraph added at the start of column 2 in Section / columns.');
plan = planMove([{ ...image, placement: undefined }, ...base], 'c', root(0));
check('announcement for a move', describeDrop(plan, label, false) === 'Paragraph moved to position 1.');

// pointer maths
const lines = [{ slot: root(0), y: 100, x: 0 }, { slot: root(1), y: 200, x: 0 }, { slot: { parentId: 's', column: 0, index: 1 }, y: 300, x: 16 }, { slot: root(2), y: 300, x: 0 }];
check('the nearest line vertically wins', pickSlot(lines, 50, 190).slot.index === 1 && pickSlot(lines, 50, 90).slot.index === 0);
check('a tie goes to the line whose left end is nearer the pointer', pickSlot(lines, 0, 300).slot.parentId === null && pickSlot(lines, 40, 300).slot.parentId === 's');
check('no lines, no pick', pickSlot([], 0, 0) === null);
check('5px does not start a drag and 6px does', !movedBeyondThreshold(3, 4) && movedBeyondThreshold(6, 0) && movedBeyondThreshold(4, 5));
check('autoscroll is 0 away from the edges', autoScrollDelta(400, 800) === 0 && autoScrollDelta(64, 800) === 0 && autoScrollDelta(736, 800) === 0);
check('autoscroll goes up near the top and down near the bottom, faster closer to the edge', autoScrollDelta(10, 800) < 0 && autoScrollDelta(790, 800) > 0 && Math.abs(autoScrollDelta(2, 800)) > Math.abs(autoScrollDelta(50, 800)) && Math.abs(autoScrollDelta(-20, 800)) <= 22);

console.log(`\n${checks} block-drop checks passed.`);
