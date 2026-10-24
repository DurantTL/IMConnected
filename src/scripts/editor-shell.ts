// The story editor's shell: the top bar, the one movable sidebar with its tabs, the layout menu, the resize handle and the
// preview dialog. Everything here is an enhancement: without JavaScript the page is the canvas followed by every sidebar
// panel, and every form submits. The module builder (story-builder.ts) meets this file through editor-bus.ts.
import { editorBus } from './editor-bus';
import { revealEditorTarget } from './editor-groups';
import {
  DEFAULT_EDITOR_LAYOUT, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_STEP, clearEditorLayout, displayedSidebarWidth, maxSidebarWidthFor,
  readEditorLayout, resizeKeys, widthFromPointer, writeEditorLayout, clampSidebarWidth, type EditorLayout,
} from '../lib/editor-layout';

const root = document.querySelector<HTMLElement>('.editor-studio');
const form = document.getElementById('draft-form') as HTMLFormElement | null;
const body = document.getElementById('ed-body');
const sidebar = document.getElementById('ed-sidebar');
if (root && form && body && sidebar) {
  const bar = document.getElementById('ed-bar')!;
  const canvas = document.getElementById('ed-canvas')!;
  const tablist = sidebar.querySelector<HTMLElement>('[role=tablist]')!;
  const tabs = Array.from(sidebar.querySelectorAll<HTMLButtonElement>('[data-studio-tab]'));
  const panels = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-studio-panel]'));
  const handle = document.getElementById('ed-resize')!;
  const rail = document.getElementById('ed-rail')!;
  const menuButton = document.getElementById('ed-layout-button') as HTMLButtonElement;
  const menu = document.getElementById('ed-layout-menu')!;
  const dialog = document.getElementById('ed-preview-dialog') as HTMLDialogElement;
  const previewFrame = document.getElementById('preview') as HTMLIFrameElement;
  const wide = window.matchMedia('(min-width: 1024px)');
  const editable = !form.querySelector('fieldset')?.disabled;
  const FOCUSABLE = 'input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary';
  let ready = false;

  root.setAttribute('data-js', '');
  for (const heading of sidebar.querySelectorAll<HTMLElement>('.ed-panel-title')) heading.tabIndex = -1;
  for (const heading of canvas.querySelectorAll<HTMLElement>('.ed-step summary > h2')) heading.tabIndex = -1;

  // ---- layout: side, width and visibility, remembered in this browser ----
  let layout: EditorLayout = readEditorLayout();
  const persist = () => { writeEditorLayout(layout); };
  const maxWidth = () => maxSidebarWidthFor(body.getBoundingClientRect().width);
  const shownWidth = () => displayedSidebarWidth(layout.width, maxWidth());
  const sidebarShown = () => layout.sidebarVisible || !wide.matches;
  const menuAction = (name: string) => menu.querySelector<HTMLButtonElement>(`[data-layout-action="${name}"]`)!;
  function applyLayout() {
    const shown = sidebarShown(), width = shownWidth(), max = maxWidth();
    root!.dataset.side = layout.side;
    root!.dataset.sidebar = shown ? 'shown' : 'hidden';
    sidebar!.hidden = !shown;
    rail.hidden = shown;
    handle.hidden = !(shown && wide.matches);
    body!.style.setProperty('--ed-sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(MIN_SIDEBAR_WIDTH));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `${width} pixels wide`);
    menuAction('toggle').textContent = layout.sidebarVisible ? 'Hide sidebar' : 'Show sidebar';
    menuAction('side').textContent = layout.side === 'right' ? 'Move sidebar to the left' : 'Move sidebar to the right';
    menuAction('narrower').disabled = width <= MIN_SIDEBAR_WIDTH;
    menuAction('wider').disabled = width >= max;
    updateNav();
  }
  function setLayout(next: EditorLayout, save = true) { layout = next; applyLayout(); if (save) persist(); }
  function setWidth(width: number, save = true) { setLayout({ ...layout, width: Math.min(clampSidebarWidth(width), maxWidth()) }, save); }
  function onLayoutAction(name: string) {
    if (name === 'toggle') {
      const hiding = layout.sidebarVisible;
      const hadFocus = sidebar!.contains(document.activeElement);
      setLayout({ ...layout, sidebarVisible: !layout.sidebarVisible });
      if (hiding && hadFocus) rail.querySelector<HTMLElement>('button')?.focus();
      if (!hiding && rail.contains(document.activeElement)) tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.focus();
    }
    else if (name === 'side') setLayout({ ...layout, side: layout.side === 'right' ? 'left' : 'right' });
    else if (name === 'narrower') setWidth(shownWidth() - SIDEBAR_WIDTH_STEP);
    else if (name === 'wider') setWidth(Math.min(shownWidth() + SIDEBAR_WIDTH_STEP, maxWidth()));
    else if (name === 'reset') { clearEditorLayout(); layout = { ...DEFAULT_EDITOR_LAYOUT }; applyLayout(); }
  }
  for (const control of root.querySelectorAll<HTMLElement>('[data-layout-action]')) control.addEventListener('click', () => {
    const fromMenu = menu.contains(control);
    onLayoutAction(control.dataset.layoutAction!);
    if (fromMenu) { setMenu(false); menuButton.focus(); }
  });
  // One scroll (issue #150): the sidebar sticks under the top of the page only while all of it fits in the window. A taller
  // sidebar is not sticky and scrolls with the page, so there is never a scrollbar inside it. Its height does not depend on
  // whether it sticks, so measuring it cannot flip-flop.
  function updateSticky() {
    const fits = wide.matches && sidebar!.offsetHeight + 24 <= window.innerHeight;
    root!.dataset.sidebarFits = String(fits);
  }
  wide.addEventListener('change', () => { applyLayout(); updateSticky(); });
  window.addEventListener('resize', updateSticky);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => applyLayout()).observe(body);
    new ResizeObserver(updateSticky).observe(sidebar);
  }

  // The layout menu: a button that opens a group; Escape closes it and gives focus back.
  const setMenu = (open: boolean) => { menu.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); };
  menuButton.addEventListener('click', () => setMenu(menu.hidden));
  document.addEventListener('click', (event) => { if (!menu.hidden && !menu.contains(event.target as Node) && !menuButton.contains(event.target as Node)) setMenu(false); });
  const escapeMenu = (event: KeyboardEvent) => { if (event.key === 'Escape' && !menu.hidden) { event.stopPropagation(); setMenu(false); menuButton.focus(); } };
  menu.addEventListener('keydown', escapeMenu);
  menuButton.addEventListener('keydown', escapeMenu);

  // The resize handle: pointer drag, and the arrow keys (40px a press) when it is focused.
  let dragging = false;
  handle.addEventListener('pointerdown', (event) => { dragging = true; handle.setPointerCapture(event.pointerId); event.preventDefault(); });
  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = body.getBoundingClientRect();
    setWidth(widthFromPointer(layout.side, event.clientX, rect.left, rect.right), false);
  });
  const endDrag = (event: PointerEvent) => { if (!dragging) return; dragging = false; try { handle.releasePointerCapture(event.pointerId); } catch { /* already released */ } persist(); };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('keydown', (event) => {
    const keys = resizeKeys(layout.side);
    if (event.key === keys.widen) setWidth(Math.min(shownWidth() + SIDEBAR_WIDTH_STEP, maxWidth()));
    else if (event.key === keys.narrow) setWidth(shownWidth() - SIDEBAR_WIDTH_STEP);
    else if (event.key === 'Home') setWidth(MIN_SIDEBAR_WIDTH);
    else if (event.key === 'End') setWidth(maxWidth());
    else return;
    event.preventDefault();
  });

  // ---- sidebar tabs ----
  let currentTab = '';
  let navCurrent: 'editor' | 'settings' | 'review' = 'editor';
  function updateNav() {
    for (const link of bar.querySelectorAll<HTMLElement>('[data-editor-nav]')) {
      if (link.dataset.editorNav === navCurrent && (navCurrent === 'editor' || sidebarShown())) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
    }
  }
  const visibleTabs = () => tabs.filter((t) => !t.hidden);
  function showTab(name: string, focus = false) {
    const tab = tabs.find((t) => t.dataset.studioTab === name && !t.hidden);
    if (!tab) return; // not a sidebar tab (the canvas parts) or one this draft does not have
    if (ready && !layout.sidebarVisible && wide.matches) { layout = { ...layout, sidebarVisible: true }; persist(); applyLayout(); }
    currentTab = name;
    for (const t of tabs) { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
    for (const panel of panels) { const on = panel.dataset.studioPanel === name; panel.hidden = !on; panel.inert = !on; }
    navCurrent = name === 'settings' || name === 'review' ? name : 'editor';
    updateNav();
    root!.setAttribute('data-active-tab', name);
    if (focus) panels.find((p) => p.dataset.studioPanel === name)?.querySelector<HTMLElement>('.ed-panel-title')?.focus();
    if (ready) {
      if (!wide.matches) sidebar!.scrollIntoView({ block: 'start' });
      if (window.location.hash !== `#${name}`) window.history.replaceState(null, '', `#${name}`);
    }
  }
  editorBus.showTab = showTab;
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.studioTab!, false));
    tab.addEventListener('keydown', (event) => {
      const list = visibleTabs();
      let index = list.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % list.length;
      else if (event.key === 'ArrowLeft') index = (index + list.length - 1) % list.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = list.length - 1;
      else return;
      event.preventDefault();
      list[index].focus(); showTab(list[index].dataset.studioTab!);
    });
  }
  tablist.hidden = false;

  // Links and buttons that open a tab (or a part of the canvas) and move focus to a real control there.
  for (const control of root.querySelectorAll<HTMLElement>('[data-open-panel]')) control.addEventListener('click', (event) => {
    const hash = control instanceof HTMLAnchorElement ? control.getAttribute('href') : null;
    if (hash?.startsWith('#')) event.preventDefault();
    const name = control.dataset.openPanel!;
    showTab(name, !hash);
    const target = hash && hash.length > 1 ? document.querySelector<HTMLElement>(hash) : null;
    if (!target) return;
    let focusTarget: HTMLElement = target;
    // "N photos have no description" opens the first photo that lacks one.
    if (target.id === 'photos') focusTarget = Array.from(target.querySelectorAll<HTMLInputElement>('input[name^="photo_"][name$="_alt"]')).find((input) => !input.value.trim()) ?? target;
    // A field in a collapsed group or card is opened first, then focused.
    revealEditorTarget(focusTarget);
    const heading = target.closest<HTMLElement>('[data-studio-panel], .ed-step')?.querySelector<HTMLElement>('.ed-panel-title, .ed-step summary > h2') ?? (target.matches('.ed-step') ? target.querySelector<HTMLElement>('h2') : null);
    const visible = (el: HTMLElement) => el.getClientRects().length > 0;
    const inner = focusTarget.matches(FOCUSABLE) ? focusTarget : Array.from(focusTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => !el.matches('summary') && visible(el)) ?? heading;
    inner?.focus();
    (inner ?? target).scrollIntoView({ block: 'center' });
  });
  // The "Editor" link takes focus to the canvas.
  bar.querySelector('[data-editor-nav="editor"]')?.addEventListener('click', (event) => {
    event.preventDefault(); navCurrent = 'editor'; updateNav(); canvas.focus(); canvas.scrollIntoView({ block: 'start' });
  });

  // ---- preview dialog: a modal over the editor, with the existing private preview inside ----
  let opener: HTMLElement | null = null;
  const behind = () => [bar, body, menu, ...Array.from(root!.querySelectorAll<HTMLElement>('.studio-mobile-actions'))];
  function openPreview(from?: HTMLElement | null) {
    if (dialog.open) return;
    opener = from ?? (document.activeElement as HTMLElement | null);
    for (const el of behind()) el.inert = true;
    dialog.showModal();
    editorBus.revealSelected();
    dialog.querySelector<HTMLElement>('[data-preview-close]')?.focus();
  }
  let restoreFocus = true;
  function closePreview(restore = true) { if (dialog.open) { restoreFocus = restore; dialog.close(); for (const el of behind()) el.inert = false; } }
  editorBus.closePreview = closePreview;
  dialog.addEventListener('close', () => {
    for (const el of behind()) el.inert = false;
    if (restoreFocus) (opener && document.contains(opener) ? opener : root!.querySelector<HTMLElement>('[data-studio-preview]'))?.focus();
    restoreFocus = true;
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closePreview(); });
  // Focus inside the preview frame is outside the dialog's own keyboard handling, so Escape is listened for there too.
  previewFrame.addEventListener('load', () => previewFrame.contentDocument?.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePreview(); }));
  for (const control of root.querySelectorAll<HTMLElement>('[data-studio-preview]')) control.addEventListener('click', () => openPreview(control));
  for (const close of root.querySelectorAll('[data-preview-close]')) close.addEventListener('click', () => closePreview());

  // ---- keyboard: "/" jumps to the module search ----
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || dialog.open) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input,textarea,select,[contenteditable]')) return;
    const search = document.getElementById('module-library-search') as HTMLInputElement | null;
    if (!editable || !search || document.getElementById('module-workspace')?.hidden) return;
    event.preventDefault(); showTab('modules'); search.focus();
  });
  for (const add of root.querySelectorAll('[data-rail-add]')) add.addEventListener('click', () => { showTab('modules'); (document.getElementById('module-library-search') as HTMLElement | null)?.focus(); });

  // ---- controls outside the form's own markup (the sidebar's Story settings) still mark the draft changed ----
  root.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || form.contains(target) || (target as HTMLInputElement).form !== form || target.closest('[data-editor-local]')) return;
    form.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // ---- what the page shows about the draft follows what is typed ----
  const saveStatus = document.getElementById('save-status');
  const mobileSaveStatus = document.querySelector('[data-mobile-save-status]');
  if (saveStatus && mobileSaveStatus) {
    const reflect = () => { mobileSaveStatus.textContent = saveStatus.textContent; };
    reflect();
    new MutationObserver(reflect).observe(saveStatus, { childList: true, subtree: true, characterData: true });
  }
  const bodyField = document.getElementById('f-body') as HTMLTextAreaElement;
  const blocksField = document.getElementById('story-blocks') as HTMLInputElement;
  // The one-line summaries of the collapsed step cards, the key points count and the photo layout name.
  const cardSummary = (name: string) => canvas.querySelector<HTMLElement>(`[data-card-summary="${name}"]`);
  const photoCount = canvas.querySelectorAll('ol.ed-photos > li').length;
  function refreshCardSummaries() {
    const value = (name: string) => ((form!.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '').trim();
    const points = [0, 1, 2].filter((i) => value(`keyPoint${i}`)).length;
    const counter = canvas.querySelector('[data-kp-count]'); if (counter) counter.textContent = String(points);
    const details = cardSummary('details');
    if (details) details.textContent = [value('title') || 'No headline yet', points ? `${points} key ${points === 1 ? 'point' : 'points'}` : ''].filter(Boolean).join(' · ');
    const layoutInput = form!.querySelector<HTMLInputElement>('input[name="photoLayout"]:checked');
    const layoutName = layoutInput?.closest('label')?.querySelector('.lay-name')?.textContent ?? '';
    const layoutLabel = canvas.querySelector('[data-layout-name]'); if (layoutLabel) layoutLabel.textContent = layoutName;
    const photos = cardSummary('photos');
    if (photos) photos.textContent = photoCount ? `${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} · ${layoutName}` : 'No photos yet';
    const story = cardSummary('story');
    if (story) {
      const modules = document.getElementById('module-count')?.textContent?.trim();
      const modular = document.getElementById('split')?.dataset.mode === 'modules';
      const words = bodyField.value.trim() ? bodyField.value.trim().split(/\s+/).length : 0;
      story.textContent = modular ? `${modules || 0} modules` : words ? `Markdown · ${words} ${words === 1 ? 'word' : 'words'}` : 'No text yet';
    }
  }
  const moduleCount = document.getElementById('module-count');
  if (moduleCount) new MutationObserver(refreshCardSummaries).observe(moduleCount, { childList: true, characterData: true, subtree: true });
  // The Announcement section only applies to announcements and events; without JavaScript it is simply shown.
  const announcementGroup = root.querySelector<HTMLElement>('[data-announcement-group]');
  const kindSelect = form.elements.namedItem('announcementKind') as HTMLSelectElement | null;
  const syncAnnouncementGroup = () => { if (announcementGroup && kindSelect) announcementGroup.hidden = kindSelect.value === 'story'; };
  kindSelect?.addEventListener('change', syncAnnouncementGroup);
  syncAnnouncementGroup();
  form.addEventListener('input', () => {
    refreshCardSummaries();
    const value = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '').trim();
    const storyTitle = value('title') || 'Untitled story';
    const author = value('author') || 'Add an author in Story settings';
    for (const el of document.querySelectorAll('.ed-headline')) el.textContent = storyTitle;
    const reviewTitle = document.querySelector('[data-review-title]'); if (reviewTitle) reviewTitle.textContent = storyTitle;
    const reviewAuthor = document.querySelector('[data-review-author]'); if (reviewAuthor) reviewAuthor.textContent = author;
    const sectionSelect = form.elements.namedItem('section') as HTMLSelectElement | null, areaSelect = form.elements.namedItem('area') as HTMLSelectElement | null;
    const area = areaSelect?.value && !areaSelect.selectedOptions[0]?.hidden ? areaSelect.selectedOptions[0]?.textContent ?? '' : '';
    const sectionText = sectionSelect?.value ? [sectionSelect.selectedOptions[0]?.textContent, area].filter(Boolean).join(' · ') : '';
    const line = [sectionText, value('author'), value('date'), value('church')].filter(Boolean).join(' · ');
    for (const el of document.querySelectorAll('[data-details-text]')) el.textContent = line || 'Section, author and date are set in Story settings.';
    const missing: Record<string, boolean> = { title: !value('title'), author: !value('author'), section: !value('section'), date: !value('date'), body: !bodyField.value.trim() };
    for (const li of document.querySelectorAll<HTMLElement>('[data-problem]')) li.hidden = !missing[li.dataset.problem!];
    const list = document.querySelector<HTMLElement>('.ed-problems'), ok = document.querySelector<HTMLElement>('.ed-ok');
    if (list && ok) { const any = Array.from(list.children).some((li) => !(li as HTMLElement).hidden); list.hidden = !any; ok.hidden = any; }
  });

  // ---- start: the layout, then the tab the address or the last action asks for ----
  const notice = new URLSearchParams(location.search).get('n');
  applyLayout();
  updateSticky();
  const wanted = location.hash.slice(1);
  let emptyStory = false;
  try { emptyStory = !!JSON.parse(document.getElementById('story-builder-data')?.textContent || '{}').emptyStory; } catch { /* the page still works */ }
  const initial = tabs.some((t) => t.dataset.studioTab === wanted && !t.hidden) ? wanted : notice === 'published' && editable ? 'review' : editable ? (emptyStory ? 'module' : 'modules') : 'settings';
  showTab(initial);
  ready = true;
  // After a photo action the page comes back to the photos.
  if (['photos', 'uploaded', 'photo_moved', 'photos_markers', 'photo_replaced', 'photo_unchanged'].includes(notice ?? '') && !location.hash) document.getElementById('photos')?.scrollIntoView({ block: 'start' });
}
