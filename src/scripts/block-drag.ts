// Dragging story modules (issue #151). Pointer events (mouse, pen and touch), not HTML5 drag and drop: a library item is dragged
// from the sidebar onto the canvas (an insert, exactly like "+ Add") and a module card is dragged by its handle (a move). The
// position maths and refusals are in src/lib/block-drop.ts; this file is the pointer handling and the animation:
//   - 6px of movement starts a drag with a mouse or pen; a touch needs a 250ms press first, so normal scrolling still works;
//   - a ghost follows the pointer, the dragged item lifts, a 3px navy line shows where it will land, the cards after the line
//     slide apart (FLIP transforms, about 180ms), a drop settles into place and flashes purple-soft for about 600ms;
//   - an invalid target shows a coral line and the reason, and a drop there changes nothing;
//   - the window scrolls itself within 64px of its top or bottom edge; Escape (or a lost pointer) cancels and returns the item;
//   - under prefers-reduced-motion: reduce there are no transforms, transitions or flashes: every change is instant.
// The builder (story-builder.ts) owns the blocks, undo, autosave and announcements; it hands them in through `DragApi`, so an
// insert or move is committed exactly like its other edits. Keyboard users keep Move up/down, Enter on a library item and the
// arrow keys on a handle.
import { AUTOSCROLL_EDGE_PX, DRAG_THRESHOLD_PX, LONG_PRESS_MS, autoScrollDelta, describeDrop, movedBeyondThreshold, pickSlot, planInsert, planMove, type DropPlan, type DropSlot, type SlotCandidate } from '../lib/block-drop';
import { walkStoryBlocks, type StoryBlock } from '../lib/story-blocks';

export interface DragApi {
  editable: boolean;
  isModular(): boolean;
  blocks(): StoryBlock[];
  outline: HTMLElement;
  canvas: HTMLElement;
  /** A new module of this type with the defaults "+ Add" gives it, or null when it cannot be added (no photos). */
  make(type: StoryBlock['type']): StoryBlock | null;
  label(block: StoryBlock): string;
  announce(message: string): void;
  /** Applies a planned insert or move: undo, selection, render, changed (autosave). `added` is true for a new module. */
  commit(plan: Extract<DropPlan, { kind: 'ok' }>, added: boolean, message: string): void;
}

interface Candidate extends SlotCandidate { beforeIdx: number }
const ROOM = 28; // px the cards after the line slide down to make room

export function initBlockDrag(api: DragApi) {
  const { outline, canvas } = api;
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cardOf = (id: string) => [...outline.children].find((el) => (el as HTMLElement).dataset.moduleId === id) as HTMLElement | undefined;
  let busy = false;

  document.addEventListener('pointerdown', (event) => {
    if (busy || !api.editable || !api.isModular()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && !event.isPrimary) return;
    const target = event.target as Element | null;
    const item = target?.closest<HTMLButtonElement>('button[data-library-item]');
    const handle = item ? null : target?.closest<HTMLButtonElement>('button[data-drag-handle]');
    const source = item ?? handle;
    if (!source || source.disabled) return;
    if (item) { if (!api.make(item.dataset.addModule as StoryBlock['type'])) return; } // an Image with no photo cannot be added, so it cannot be dragged
    begin(event, source, item ? { kind: 'add', type: item.dataset.addModule as StoryBlock['type'] } : { kind: 'move', id: handle!.closest<HTMLElement>('li[data-module-card]')!.dataset.moduleId! });
  }, true);

  type Job = { kind: 'add'; type: StoryBlock['type'] } | { kind: 'move'; id: string };

  function begin(down: PointerEvent, source: HTMLElement, job: Job) {
    busy = true;
    const touch = down.pointerType !== 'mouse' && down.pointerType !== 'pen' ? true : false;
    const startX = down.clientX, startY = down.clientY;
    let x = startX, y = startY;
    let state: 'pending' | 'dragging' | 'done' = 'pending';
    let armed = !touch; // a touch must be held first
    let timer = 0;
    let ghost: HTMLElement | null = null, line: HTMLElement | null = null;
    let candidates: Candidate[] = [];
    let current: { candidate: Candidate; plan: DropPlan } | null = null;
    let raf = 0;
    let reduced = reducedQuery.matches;
    const pointerId = down.pointerId;
    const els = () => [...outline.children].filter((el) => (el as HTMLElement).matches('[data-module-card],[data-drop-empty]')) as HTMLElement[];

    const listeners: [EventTarget, string, EventListener, AddEventListenerOptions | boolean][] = [];
    const on = (target: EventTarget, type: string, fn: (e: any) => void, options: AddEventListenerOptions | boolean = true) => { target.addEventListener(type, fn, options); listeners.push([target, type, fn, options]); };
    const off = () => { for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o); listeners.length = 0; };

    if (touch) timer = window.setTimeout(() => { armed = true; start(); }, LONG_PRESS_MS);
    on(window, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      x = e.clientX; y = e.clientY;
      if (state === 'pending') {
        if (touch && !armed) { if (movedBeyondThreshold(x - startX, y - startY)) finish(true, false); return; } // the finger is scrolling
        if (movedBeyondThreshold(x - startX, y - startY, DRAG_THRESHOLD_PX)) start();
      }
      if (state === 'dragging') { e.preventDefault(); follow(); }
    });
    on(window, 'pointerup', (e: PointerEvent) => { if (e.pointerId === pointerId) finish(false, state === 'dragging', true); });
    on(window, 'pointercancel', (e: PointerEvent) => { if (e.pointerId === pointerId) finish(true, state === 'dragging', true); });
    on(document, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && state === 'dragging') { e.preventDefault(); e.stopPropagation(); finish(true, true); } });
    on(window, 'blur', () => { if (state === 'dragging') finish(true, true); }, false);
    on(window, 'scroll', () => { if (state === 'dragging') follow(); }, false);
    // A held touch must not open the context menu or pan the page once the drag has started.
    on(document, 'contextmenu', (e: Event) => { if (touch) e.preventDefault(); });
    on(document, 'touchmove', (e: Event) => { if (state === 'dragging' && e.cancelable) e.preventDefault(); }, { passive: false, capture: true });

    function rects(): Map<string, DOMRect> {
      const map = new Map<string, DOMRect>();
      for (const el of els()) map.set(el.dataset.moduleId ?? `empty:${el.dataset.parentId}:${el.dataset.column}`, el.getBoundingClientRect());
      return map;
    }
    /** FLIP: every card animates from where it was to where the layout now puts it. */
    function flip(before: Map<string, DOMRect>) {
      if (reduced) return;
      for (const el of els()) {
        const key = el.dataset.moduleId ?? `empty:${el.dataset.parentId}:${el.dataset.column}`;
        const was = before.get(key);
        if (!was) continue;
        const dy = was.top - el.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) continue;
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
      }
    }

    function start() {
      if (state !== 'pending') return;
      window.clearTimeout(timer);
      state = 'dragging';
      reduced = reducedQuery.matches;
      try { source.setPointerCapture(pointerId); } catch { /* a synthetic pointer has nothing to capture */ }
      document.documentElement.classList.add('sb-dragging');
      source.classList.add('is-lifted');
      ghost = document.createElement('div');
      ghost.className = 'sb-drag-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.textContent = job.kind === 'add' ? `+ ${source.textContent?.trim() ?? ''}` : (source.closest('li')?.querySelector('.sb-select-module')?.firstChild?.textContent ?? 'Module').trim() || 'Module';
      document.body.append(ghost);
      line = document.createElement('div');
      line.className = 'sb-drop-line';
      line.hidden = true;
      line.setAttribute('aria-hidden', 'true');
      line.dataset.testid = 'drop-line';
      const tip = document.createElement('span');
      tip.className = 'sb-drop-tip';
      line.append(tip);
      outline.append(line);
      const before = rects();
      outline.classList.add('is-dnd'); // the "+" rows fold away so the cards sit together
      candidates = measure(); // before the FLIP animations start: a running transform would move the rectangles
      flip(before);
      moveGhost();
      follow();
      loop();
    }

    /** Where every landing line is, in page coordinates (so it survives scrolling). */
    function measure(): Candidate[] {
      const list = els();
      const r = list.map((el) => el.getBoundingClientRect());
      const sx = window.scrollX, sy = window.scrollY;
      const root = api.blocks();
      const out: Candidate[] = [];
      const indexOf = new Map(list.map((el, i) => [el.dataset.moduleId ?? `empty:${el.dataset.parentId}:${el.dataset.column}`, i]));
      const isRoot = (i: number) => list[i]?.dataset.parentId === '' && list[i].matches('[data-module-card]');
      const mid = (k: number) => (r[k - 1].bottom + r[k].top) / 2;
      const push = (slot: DropSlot, y: number, left: number, beforeIdx: number) => out.push({ slot, y: y + sy, x: left + sx, beforeIdx });
      const rootStart = (i: number) => indexOf.get(root[i].id)!;
      for (const [i, block] of root.entries()) {
        const k = rootStart(i);
        // The line above a top-level module: below the previous subtree (a section's last child) it sits just under the gap's middle.
        push({ parentId: null, column: 0, index: i }, k === 0 ? r[0].top - 3 : mid(k) + (isRoot(k - 1) ? 0 : 2), r[k].left, k);
        for (const [column, children] of (block.content ?? []).entries()) {
          if (!children.length) {
            const e = indexOf.get(`empty:${block.id}:${column}`)!;
            push({ parentId: block.id, column, index: 0 }, (r[e].top + r[e].bottom) / 2, r[e].left, e + 1);
            continue;
          }
          for (const [j, child] of children.entries()) {
            const c = indexOf.get(child.id)!;
            push({ parentId: block.id, column, index: j }, j === 0 ? r[c].top - 3 : mid(c), r[c].left, c);
          }
          const last = indexOf.get(children[children.length - 1].id)!;
          push({ parentId: block.id, column, index: children.length }, r[last].bottom + 2, r[last].left, last + 1);
        }
      }
      if (list.length) push({ parentId: null, column: 0, index: root.length }, r[list.length - 1].bottom + (isRoot(list.length - 1) ? 3 : 11), r[list.length - 1].left - (isRoot(list.length - 1) ? 0 : 16), list.length);
      else push({ parentId: null, column: 0, index: 0 }, outline.getBoundingClientRect().top, outline.getBoundingClientRect().left, 0);
      return out;
    }

    function overCanvas() {
      const box = canvas.getBoundingClientRect();
      return x >= box.left - 24 && x <= box.right + 24;
    }
    function planFor(slot: DropSlot): DropPlan {
      if (job.kind === 'move') return planMove(api.blocks(), job.id, slot);
      const block = api.make(job.type);
      return block ? planInsert(api.blocks(), block, slot) : { kind: 'nothing' };
    }

    function moveGhost() {
      if (!ghost) return;
      if (reduced) { ghost.style.left = `${x + 14}px`; ghost.style.top = `${y + 14}px`; }
      else ghost.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0) scale(1.04)`;
    }
    function setShift(from: number) {
      if (reduced) return;
      els().forEach((el, i) => { el.style.transform = from >= 0 && i >= from ? `translateY(${ROOM}px)` : ''; });
    }
    function follow() {
      moveGhost();
      if (!line) return;
      const picked = overCanvas() ? pickSlot(candidates, x + window.scrollX, y + window.scrollY) : null;
      if (!picked) { current = null; line.hidden = true; setShift(-1); return; }
      const plan = current?.candidate === picked ? current.plan : planFor(picked.slot);
      current = { candidate: picked, plan };
      if (plan.kind === 'nothing') { line.hidden = true; setShift(-1); return; }
      const invalid = plan.kind === 'error';
      const box = outline.getBoundingClientRect();
      const room = !reduced && picked.beforeIdx < els().length;
      line.hidden = false;
      line.dataset.state = invalid ? 'invalid' : 'ok';
      line.style.left = `${picked.x - window.scrollX - box.left}px`;
      line.style.right = '0px';
      line.style.top = `${picked.y - window.scrollY - box.top + (room ? ROOM / 2 : 0) - 1.5}px`;
      (line.firstChild as HTMLElement).textContent = invalid ? `Not allowed: ${plan.message}` : '';
      setShift(invalid ? -1 : picked.beforeIdx);
    }
    function loop() {
      cancelAnimationFrame(raf);
      const tick = () => {
        if (state !== 'dragging') return;
        const delta = autoScrollDelta(y, window.innerHeight, AUTOSCROLL_EDGE_PX);
        if (delta) { window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior }); follow(); }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function cleanup() {
      state = 'done';
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      off();
      document.documentElement.classList.remove('sb-dragging');
      source.classList.remove('is-lifted');
      try { source.releasePointerCapture(pointerId); } catch { /* not captured */ }
      outline.classList.remove('is-dnd');
      line?.remove();
      for (const el of els()) el.style.transform = '';
      // The click that follows the pointer-up is swallowed by a listener removed one tick later.
      setTimeout(() => { busy = false; }, 0);
    }
    function finish(cancel: boolean, wasDragging: boolean, pointerUp = false) {
      if (state === 'done') return;
      if (!wasDragging) {
        // Never became a drag: a plain click still adds the module, a held-then-scrolled touch does nothing.
        state = 'pending'; cleanup(); busy = false; return;
      }
      const before = rects();
      const dropped = current;
      const ghostBox = ghost?.getBoundingClientRect();
      const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
      // The click that follows the release must not add the module (or select a card). After Escape the pointer is still down, so wait for its release first.
      document.addEventListener('click', swallow, true);
      const stop = () => setTimeout(() => document.removeEventListener('click', swallow, true), 50);
      if (pointerUp) stop(); else window.addEventListener('pointerup', stop, { once: true, capture: true });
      cleanup();
      const dropAt = ghostBox;
      if (cancel || !dropped || !overCanvas()) {
        returnGhost(ghost, source, reduced);
        ghost = null;
        flip(before);
        api.announce('Move cancelled.');
        return;
      }
      const plan = dropped.plan;
      if (plan.kind === 'error') { returnGhost(ghost, source, reduced); ghost = null; flip(before); api.announce(plan.message); return; }
      if (plan.kind === 'nothing') { removeGhost(ghost); ghost = null; flip(before); api.announce('Module left where it was.'); return; }
      const added = job.kind === 'add';
      api.commit(plan, added, describeDrop(plan, api.label, added));
      removeGhost(ghost); ghost = null;
      const card = cardOf(plan.id);
      if (card && !reduced) {
        flip(before);
        if (dropAt) {
          const now = card.getBoundingClientRect();
          card.animate([{ transform: `translate(${dropAt.left - now.left}px, ${dropAt.top - now.top}px) scale(1.03)`, opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
        card.classList.add('sb-flash');
        setTimeout(() => card.classList.remove('sb-flash'), 650);
      }
    }
  }

  function removeGhost(ghost: HTMLElement | null) { ghost?.remove(); }
  /** Escape or a refused drop: the ghost glides back to where the item came from. */
  function returnGhost(ghost: HTMLElement | null, source: HTMLElement, reduced: boolean) {
    if (!ghost) return;
    if (reduced) { ghost.remove(); return; }
    const from = ghost.getBoundingClientRect(), to = source.getBoundingClientRect();
    const animation = ghost.animate([{ transform: `translate3d(${from.left}px, ${from.top}px, 0) scale(1.04)`, opacity: .85 }, { transform: `translate3d(${to.left}px, ${to.top}px, 0) scale(1)`, opacity: 0 }], { duration: 180, easing: 'ease-in' });
    animation.onfinish = () => ghost.remove();
    animation.oncancel = () => ghost.remove();
  }
}
