// The story editor's movable sidebar: where it sits, how wide it is, and whether it is shown. Pure functions plus a
// storage wrapper, so the rules can be tested without a browser. The layout is remembered per browser; every storage
// access is wrapped in try/catch because storage can be missing or throw (private windows, blocked site data, previews).

export type SidebarSide = 'left' | 'right';
export interface EditorLayout { sidebarVisible: boolean; side: SidebarSide; width: number }

export const DEFAULT_EDITOR_LAYOUT: EditorLayout = { sidebarVisible: true, side: 'right', width: 380 };
export const MIN_SIDEBAR_WIDTH = 300;
export const MAX_SIDEBAR_WIDTH = 600;
/** One press of an arrow key, or of the narrower / wider buttons. */
export const SIDEBAR_WIDTH_STEP = 40;
/** The share of the editor's width the sidebar may take; the stylesheet's `max-width` is the same figure. */
export const SIDEBAR_MAX_SHARE = 0.5;
export const EDITOR_LAYOUT_STORAGE_KEY = 'imc.storyEditor.layout.v1';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_EDITOR_LAYOUT.width;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

/** The most the sidebar can be in a body `containerWidth` wide (it may take half), never above the overall maximum. */
export function maxSidebarWidthFor(containerWidth: number | null): number {
  if (!containerWidth) return MAX_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(containerWidth * SIDEBAR_MAX_SHARE)));
}

/** The width the sidebar really has: its remembered width, held inside what the page has room for. */
export function displayedSidebarWidth(width: number, maxWidth: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(clampSidebarWidth(width), maxWidth));
}

/** The width a drag to `pointerX` gives, for a sidebar whose body spans `containerLeft`..`containerRight`. */
export function widthFromPointer(side: SidebarSide, pointerX: number, containerLeft: number, containerRight: number): number {
  return clampSidebarWidth(side === 'right' ? containerRight - pointerX : pointerX - containerLeft);
}

/** The key that widens and the key that narrows the sidebar: the handle is the sidebar's inner edge. */
export function resizeKeys(side: SidebarSide): { widen: string; narrow: string } {
  return side === 'right' ? { widen: 'ArrowLeft', narrow: 'ArrowRight' } : { widen: 'ArrowRight', narrow: 'ArrowLeft' };
}

/** Reads a stored layout; anything missing, malformed or out of range falls back to the default for that part. */
export function parseEditorLayout(raw: string | null | undefined): EditorLayout {
  if (!raw) return { ...DEFAULT_EDITOR_LAYOUT };
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof EditorLayout, unknown>> | null;
    if (!value || typeof value !== 'object') return { ...DEFAULT_EDITOR_LAYOUT };
    return {
      sidebarVisible: typeof value.sidebarVisible === 'boolean' ? value.sidebarVisible : DEFAULT_EDITOR_LAYOUT.sidebarVisible,
      side: value.side === 'left' || value.side === 'right' ? value.side : DEFAULT_EDITOR_LAYOUT.side,
      width: typeof value.width === 'number' ? clampSidebarWidth(value.width) : DEFAULT_EDITOR_LAYOUT.width,
    };
  } catch {
    return { ...DEFAULT_EDITOR_LAYOUT };
  }
}

export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser's localStorage, or null when it is missing or refuses access (reading the property can itself throw). */
export function browserLayoutStorage(): LayoutStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readEditorLayout(storage: LayoutStorage | null = browserLayoutStorage()): EditorLayout {
  if (!storage) return { ...DEFAULT_EDITOR_LAYOUT };
  try {
    return parseEditorLayout(storage.getItem(EDITOR_LAYOUT_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_EDITOR_LAYOUT };
  }
}

/** Returns false when the layout could not be remembered; the editor keeps working with the layout in memory. */
export function writeEditorLayout(layout: EditorLayout, storage: LayoutStorage | null = browserLayoutStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(EDITOR_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

export function clearEditorLayout(storage: LayoutStorage | null = browserLayoutStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(EDITOR_LAYOUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
