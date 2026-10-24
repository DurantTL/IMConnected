// Which collapsible sidebar groups and canvas cards of the story editor are open, remembered per browser (issue #150).
// Pure parsing plus a storage wrapper, like editor-layout.ts: every storage access is in try/catch, and anything missing or
// malformed is ignored (the group then uses its own default). Shape: { <scope>: { <group>: true|false } } where the scope is
// a sidebar tab ('modules', 'settings', 'review') or 'canvas' for the step cards.
export const EDITOR_GROUPS_STORAGE_KEY = 'imc.storyEditor.groups.v1';
export type GroupState = Record<string, Record<string, boolean>>;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseGroupState(raw: string | null | undefined): GroupState {
  const out: GroupState = {};
  if (!raw) return out;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [scope, groups] of Object.entries(value as Record<string, unknown>)) {
      if (!NAME.test(scope) || !groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
      const clean: Record<string, boolean> = {};
      for (const [name, open] of Object.entries(groups as Record<string, unknown>)) if (NAME.test(name) && typeof open === 'boolean') clean[name] = open;
      out[scope] = clean;
    }
  } catch { /* a damaged value is the same as none */ }
  return out;
}

type GroupStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): GroupStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readGroupState(storage: GroupStorage | null = browserStorage()): GroupState {
  if (!storage) return {};
  try { return parseGroupState(storage.getItem(EDITOR_GROUPS_STORAGE_KEY)); } catch { return {}; }
}

/** Remembers one group's state; returns false when it could not be stored (the editor keeps working with it in memory). */
export function writeGroupState(scope: string, name: string, open: boolean, storage: GroupStorage | null = browserStorage()): boolean {
  if (!storage || !NAME.test(scope) || !NAME.test(name)) return false;
  try {
    const state = parseGroupState(storage.getItem(EDITOR_GROUPS_STORAGE_KEY));
    state[scope] = { ...state[scope], [name]: open };
    storage.setItem(EDITOR_GROUPS_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch { return false; }
}

/** The state a group starts in: the remembered one, else its own default. */
export function initialGroupOpen(state: GroupState, scope: string, name: string, defaultOpen: boolean): boolean {
  const remembered = state[scope]?.[name];
  return typeof remembered === 'boolean' ? remembered : defaultOpen;
}
