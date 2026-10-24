// Collapsible groups of the story editor (issue #150): the sidebar's module library and settings sections, the Publish tab's
// schedule and reject sections, the canvas step cards, key points and per-photo details. Every group is a native
// <details data-group="<name>"> that the server renders open, so without JavaScript everything is open and every field submits.
// Here each one gets its remembered (or default) state, an aria-expanded mirror on its summary, and persistence.
// A closed group still submits its fields (they stay in the form); `revealEditorTarget` opens whatever holds a target first.
import { initialGroupOpen, readGroupState, writeGroupState } from '../lib/editor-groups';

const root = document.querySelector<HTMLElement>('.editor-studio');
const groups = () => Array.from(root?.querySelectorAll<HTMLDetailsElement>('details[data-group]') ?? []);

export function groupScope(group: HTMLElement): string {
  return group.closest<HTMLElement>('[data-studio-panel]')?.dataset.studioPanel ?? 'canvas';
}
/** Opens or closes a group without remembering it (a search or a problem link is not the editor's own choice). */
export function setGroup(group: HTMLDetailsElement, open: boolean) {
  group.dataset.set = open ? '1' : '0';
  group.open = open;
  group.querySelector(':scope > summary')?.setAttribute('aria-expanded', String(open));
}
/** Opens every collapsed group or card that holds `target`, so it can be seen and focused. Returns true when one was opened. */
export function revealEditorTarget(target: Element | null): boolean {
  let opened = false;
  for (let el = target?.closest<HTMLDetailsElement>('details[data-group]') ?? null; el; el = el.parentElement?.closest<HTMLDetailsElement>('details[data-group]') ?? null) {
    if (!el.open) { setGroup(el, true); opened = true; }
  }
  return opened;
}

if (root) {
  const state = readGroupState();
  for (const group of groups()) {
    const name = group.dataset.group!, scope = groupScope(group);
    const persist = group.dataset.groupPersist !== 'false'; // per-photo details start closed each visit
    const open = group.dataset.groupAutoOpen === 'true' || (persist ? initialGroupOpen(state, scope, name, group.dataset.groupDefault !== 'closed') : group.dataset.groupDefault !== 'closed');
    setGroup(group, open);
    // The editor's click (or Enter or Space) is recorded at once, so aria-expanded and the remembered state never lag; the
    // browser opens or closes the <details> right after this handler, and the toggle event below then finds nothing to do.
    const summary = group.querySelector<HTMLElement>(':scope > summary');
    summary?.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      const next = !group.open;
      group.dataset.set = next ? '1' : '0';
      summary.setAttribute('aria-expanded', String(next));
      if (persist) writeGroupState(scope, name, next);
    });
    // A change the editor makes (click, Enter or Space on the summary) differs from what setGroup last recorded; ours does not.
    group.addEventListener('toggle', () => {
      if (group.open === (group.dataset.set === '1')) return;
      group.dataset.set = group.open ? '1' : '0';
      group.querySelector(':scope > summary')?.setAttribute('aria-expanded', String(group.open));
      if (persist) writeGroupState(scope, name, group.open);
    });
  }
}
