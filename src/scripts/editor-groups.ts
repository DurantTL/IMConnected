// Collapsible groups of the story editor (issue #150): the sidebar's module library and settings sections, the Publish tab's
// schedule and reject sections, key points and per-photo details are native <details data-group="<name>"> the server renders
// open; the three step cards are a heading plus a disclosure button (`[data-card-group]`, `[data-card-toggle]`, `[data-card-body]`).
// Without JavaScript everything is open and every field submits. Here each group gets its remembered (or default) state,
// an aria-expanded mirror, and persistence of the editor's own choice (a click, Enter or Space; never a search, a problem
// link or the browser's find-in-page). A closed group still submits its fields (they stay in the form).
// `revealEditorTarget` opens whatever holds a target first, and `keepInView` keeps a toggled header on screen.
import { initialGroupOpen, readGroupState, writeGroupState } from '../lib/editor-groups';

type Group = HTMLElement;
const root = document.querySelector<HTMLElement>('.editor-studio');
const groups = () => Array.from(root?.querySelectorAll<Group>('details[data-group], [data-card-group]') ?? []);
const isCard = (g: Group) => g.hasAttribute('data-card-group');
const toggleOf = (g: Group) => isCard(g) ? g.querySelector<HTMLElement>(':scope > .ed-card-head > [data-card-toggle]') : g.querySelector<HTMLElement>(':scope > summary');
const bodyOf = (g: Group) => g.querySelector<HTMLElement>(':scope > [data-card-body]');

export function groupScope(group: HTMLElement): string {
  return group.closest<HTMLElement>('[data-studio-panel]')?.dataset.studioPanel ?? 'canvas';
}
export function isGroupOpen(g: Group): boolean {
  return isCard(g) ? toggleOf(g)?.getAttribute('aria-expanded') === 'true' : (g as HTMLDetailsElement).open;
}
function mirror(g: Group, open: boolean) {
  const toggle = toggleOf(g);
  toggle?.setAttribute('aria-expanded', String(open));
  if (isCard(g)) {
    const label = toggle?.dataset.label ?? '', text = toggle?.querySelector('.sr-only');
    if (text) text.textContent = `${open ? 'Collapse' : 'Expand'} ${label}`;
  }
}
/** Opens or closes a group without remembering it (a search or a problem link is not the editor's own choice). */
export function setGroup(g: Group, open: boolean) {
  g.dataset.set = open ? '1' : '0';
  if (isCard(g)) { const body = bodyOf(g); if (body) body.hidden = !open; } else (g as HTMLDetailsElement).open = open;
  mirror(g, open);
}
/** Opens every collapsed group or card that holds `target` (or is it), so it can be seen and focused. True when one was opened. */
export function revealEditorTarget(target: Element | null): boolean {
  let opened = false;
  for (let el = target?.closest<Group>('details[data-group], [data-card-group]') ?? null; el; el = el.parentElement?.closest<Group>('details[data-group], [data-card-group]') ?? null) {
    if (!isGroupOpen(el)) { setGroup(el, true); opened = true; }
  }
  return opened;
}
/** After a toggle or a tab change, a header that ended up outside the window (under the sticky tab row) is scrolled to. */
export function keepInView(el: Element | null | undefined) {
  if (!el) return;
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    if (r.top < 56 || r.bottom > window.innerHeight) (el as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
  });
}

if (root) {
  const state = readGroupState();
  for (const group of groups()) {
    const name = group.dataset.group!, scope = groupScope(group);
    const persist = group.dataset.groupPersist !== 'false'; // per-photo details start closed each visit
    const defaultOpen = group.dataset.groupDefault !== 'closed';
    setGroup(group, group.dataset.groupAutoOpen === 'true' || (persist ? initialGroupOpen(state, scope, name, defaultOpen) : defaultOpen));
    const toggle = toggleOf(group);
    // The editor's click (or Enter or Space) is recorded at once, so aria-expanded and the remembered state never lag.
    if (isCard(group)) {
      const flip = () => { const next = !isGroupOpen(group); setGroup(group, next); if (persist) writeGroupState(scope, name, next); keepInView(toggle); };
      toggle?.addEventListener('click', flip);
      // The empty part of the header toggles too, for a mouse.
      group.querySelector<HTMLElement>(':scope > .ed-card-head')?.addEventListener('click', (event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).closest('.ed-card-summary')) flip(); });
    } else {
      toggle?.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        const next = !(group as HTMLDetailsElement).open;
        group.dataset.set = next ? '1' : '0';
        mirror(group, next);
        if (persist) writeGroupState(scope, name, next);
        keepInView(toggle);
      });
      // Anything else that opens or closes the <details> (the browser's find-in-page) is mirrored but never remembered.
      group.addEventListener('toggle', () => {
        const open = (group as HTMLDetailsElement).open;
        if (open === (group.dataset.set === '1')) return;
        group.dataset.set = open ? '1' : '0';
        mirror(group, open);
      });
    }
  }
}
