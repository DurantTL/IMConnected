// The module builder (story-builder.ts) and the editor shell (editor-shell.ts) never import each other; they meet here.
// The shell replaces these no-ops when the page starts, so the builder can switch the sidebar tab or close the preview.
export const editorBus = {
  /** Opens a sidebar tab ('modules', 'module', 'settings', 'review' or 'history'); showing a hidden sidebar first. */
  showTab: (_name: string, _focus = false): void => {},
  /** Closes the preview dialog; `restoreFocus` false leaves focus where the caller put it. */
  closePreview: (_restoreFocus = true): void => {},
  /** Scrolls the open preview to the selected module (the builder sets this). */
  revealSelected: (): void => {},
};
