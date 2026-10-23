import { isStoryButtonUrl, checkStoryBlockLength, walkStoryBlocks, mapStoryBlocks, countStoryBlocks, findStoryBlockLocation, STORY_BLOCK_LIMIT, splitMarkdownIntoModules, storyBlocksToMarkdown, type StoryBlock } from '../lib/story-blocks';

const form = document.getElementById('draft-form') as HTMLFormElement | null;
const blocksField = document.getElementById('story-blocks') as HTMLInputElement | null;
if (form && blocksField) {
  const body = document.getElementById('f-body') as HTMLTextAreaElement;
  const workspace = document.getElementById('module-workspace')!;
  const markdown = document.getElementById('markdown-workspace')!;
  const outline = document.getElementById('module-outline')!;
  const fields = document.getElementById('module-fields')!;
  const title = document.getElementById('module-title')!;
  const status = document.getElementById('module-status')!;
  document.getElementById('insert-inline-photo')?.addEventListener('click', () => {
    const choice = document.getElementById('inline-photo-choice') as HTMLSelectElement;
    if (body.readOnly || !choice.value) { status.textContent = 'Choose a story photo first.'; choice.focus(); return; }
    const placement = (document.getElementById('inline-photo-placement') as HTMLSelectElement | null)?.value;
    const marker = `\n\n{{photo ${choice.value}${placement ? ` ${placement}` : ''}}}\n\n`;
    body.setRangeText(marker, body.selectionStart, body.selectionEnd, 'end');
    body.dispatchEvent(new Event('input', { bubbles: true })); body.focus();
  });
  document.getElementById('insert-inline-gallery')?.addEventListener('click', () => {
    const from = document.getElementById('gallery-photo-start') as HTMLSelectElement;
    const to = document.getElementById('gallery-photo-end') as HTMLSelectElement;
    const columns = document.getElementById('gallery-columns') as HTMLSelectElement;
    const message = document.getElementById('gallery-marker-status')!;
    if (body.readOnly || !from.value || Number(to.value) <= Number(from.value)) { message.textContent = 'Choose a range of at least two photos, in ascending order.'; from.focus(); return; }
    body.setRangeText(`\n\n{{gallery ${from.value}-${to.value} columns=${columns.value}}}\n\n`, body.selectionStart, body.selectionEnd, 'end');
    body.dispatchEvent(new Event('input', { bubbles: true })); message.textContent = 'Gallery inserted.'; body.focus();
  });
  const undo = document.getElementById('blocks-undo') as HTMLButtonElement;
  const redo = document.getElementById('blocks-redo') as HTMLButtonElement;
  const useModules = document.getElementById('use-modules') as HTMLButtonElement;
  const useMarkdown = document.getElementById('use-markdown') as HTMLButtonElement;
  const split = document.getElementById('split')!;
  const inspector = document.getElementById('module-inspector')!;
  // The part of the editor that is open (the outline decides); 'content' is the body, where a module may be selected.
  let activePanel = 'content';
  const library = document.querySelector<HTMLDetailsElement>('.sb-library-disclosure')!;
  const phone = window.matchMedia('(max-width: 650px)');
  if (phone.matches) library.open = false;
  phone.addEventListener('change', () => { library.open = !phone.matches; });
  const editable = !form.querySelector('fieldset')?.disabled;
  type Photo = { id: number; src: string; alt: string; focalX: number; focalY: number; zoom: number; fit?: 'cover' | 'contain'; fitFill?: 'blur' | 'paper' | 'navy' };
  const builderData = JSON.parse(document.getElementById('story-builder-data')?.textContent || '{"photos":[]}');
  const photos: Photo[] = builderData.photos;
  let blocks: StoryBlock[] = JSON.parse(blocksField.value || '[]');
  let modular = blocks.length > 0;
  let selected = blocks[0]?.id || '';
  const history: string[] = [];
  const future: string[] = [];
  let editKey = '';
  let editAt = 0;
  const labels: Record<StoryBlock['type'], string> = { text: 'Paragraph', heading: 'Heading', quote: 'Quote', list: 'List', image: 'Image', gallery: 'Gallery', flyer: 'Flyer', video: 'Video', section: 'Section / columns', button: 'Button / link', divider: 'Divider' };
  const uid = () => `module-${crypto.randomUUID()}`;
  if (editable && builderData.emptyStory && !blocks.length) {
    // The starter module is not an edit: opening an empty draft must not mark it changed (that would autosave, move it to review and write an audit entry).
    blocks = [{ id: uid(), type: 'text', text: '' }]; modular = true; selected = blocks[0].id;
  }
  const clone = (value: StoryBlock[]) => JSON.parse(JSON.stringify(value)) as StoryBlock[];
  const announce = (message: string) => { status.textContent = message; };
  const changed = () => form.dispatchEvent(new Event('input', { bubbles: true }));
  const snapshot = () => JSON.stringify({ blocks, modular, body: body.value, selected });
  function focusSelected() {
    const target = modular
      ? outline.querySelector<HTMLButtonElement>(`[data-select-module="${CSS.escape(selected)}"]`) || document.querySelector<HTMLButtonElement>('[data-add-module="text"]')
      : useModules;
    if (target?.closest('.sb-library-disclosure')) library.open = true;
    target?.focus();
  }
  function remember(key = '') {
    const now = Date.now();
    if (!key || key !== editKey || now - editAt > 800) {
      history.push(snapshot());
      if (history.length > 50) history.shift();
    }
    editKey = key;
    editAt = now;
    future.length = 0;
  }
  function sync() {
    blocksField!.value = JSON.stringify(modular ? blocks : []);
    body.readOnly = modular || !editable; // the modules own the text; the Markdown box is only edited in Markdown mode
    if (modular) {
      try { body.value = storyBlocksToMarkdown(blocks); }
      catch (error) { announce(error instanceof Error ? error.message : 'Check the module settings before saving.'); }
    }
    split.dataset.mode = modular ? 'modules' : 'markdown';
    workspace.hidden = !modular;
    markdown.hidden = modular;
    syncPanes();
    highlightCanvas();
    useModules.setAttribute('aria-pressed', String(modular));
    useMarkdown.setAttribute('aria-pressed', String(!modular));
    useModules.textContent = modular ? 'Modules active' : 'Split into modules';
    const bodyText = document.getElementById('outline-body-text'), bodyModules = document.getElementById('outline-body-modules');
    if (bodyText) bodyText.hidden = modular;
    if (bodyModules) bodyModules.hidden = !modular;
    const bodyHeading = document.getElementById('studio-heading-content');
    if (bodyHeading) bodyHeading.textContent = modular ? 'Story modules' : 'Body text';
    markCurrent();
    useMarkdown.textContent = modular ? 'Switch to Markdown' : 'Markdown active';
    // Undo and redo appear for module stories, and while a Markdown/module switch can still be undone.
    const undoGroup = undo.closest<HTMLElement>('.ed-undo');
    if (undoGroup) undoGroup.hidden = !modular && !history.length && !future.length;
    undo.disabled = !editable || !history.length;
    redo.disabled = !editable || !future.length;
    const count = document.getElementById('module-count');
    if (count) count.textContent = modular ? String(countStoryBlocks(blocks)) : '';
    const summary = document.querySelector('[data-review-content]');
    if (summary) summary.textContent = modular ? `${countStoryBlocks(blocks)} modules` : 'Markdown story';
    const start = document.getElementById('module-start-writing');
    if (start) start.hidden = !(blocks.length === 1 && blocks[0].type === 'text' && !blocks[0].text);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-add-module="image"], [data-add-module="gallery"], [data-add-module="flyer"]')) {
      button.disabled = !editable || !photos.some((p) => p.src);
      button.title = photos.some((p) => p.src) ? 'Place a story photo in the text' : 'Upload a photo in Photos first';
    }
  }
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(label: string, action: () => void, aria?: string) {
    const el = node('button', label);
    el.type = 'button';
    if (aria) el.setAttribute('aria-label', aria);
    el.disabled = !editable;
    el.addEventListener('click', action);
    return el;
  }
  function move(id: string, to: number) {
    const location = findStoryBlockLocation(blocks, id);
    if (!editable || !location || to < 0 || to >= location.siblings.length || location.index === to) return;
    remember();
    location.siblings.splice(to, 0, location.siblings.splice(location.index, 1)[0]); selected = id;
    render(); changed(); announce(`Module moved to position ${to + 1} in its current column.`); focusSelected();
  }
  function renderOutline() {
    outline.replaceChildren();
    let number = 0;
    const renderList = (siblings: StoryBlock[], column?: number) => { for (const [index, block] of siblings.entries()) {
      const display = ++number;
      const item = node('li');
      item.draggable = editable;
      item.dataset.moduleId = block.id;
      if (column !== undefined) item.style.marginLeft = '16px';
      // No aria-label: the visible text ("1. Paragraph ...") is the accessible name (WCAG 2.5.3 label in name).
      const select = button(`${display}. ${labels[block.type]}${column !== undefined ? ` · Column ${column + 1}` : ''}`, () => { selected = block.id; setPanel('content'); render(); focusSelected(); revealPart('module'); });
      select.dataset.selectModule = block.id;
      select.disabled = false; // choosing a module only changes what is shown, so a closed draft can still be browsed
      const grip = node('span', '⠿', 'sb-grip'); grip.setAttribute('aria-hidden', 'true'); select.prepend(grip);
      select.setAttribute('aria-pressed', String(selected === block.id));
      if (selected === block.id && activePanel === 'content') select.setAttribute('aria-current', 'true');
      select.className = 'sb-select-module';
      const summary = block.text || block.label || (block.type === 'image' ? photos.find((p) => p.id === block.photoId)?.alt : '') || '';
      if (summary) select.append(node('small', summary.slice(0, 64)));
      item.append(select);
      const actions = node('div', undefined, 'sb-module-actions');
      const up = button('Move up', () => move(block.id, index - 1), `Move up, module ${display}`);
      up.disabled = !editable || index === 0;
      const down = button('Move down', () => move(block.id, index + 1), `Move down, module ${display}`);
      down.disabled = !editable || index === siblings.length - 1;
      actions.append(up, down);
      item.append(actions);
      item.addEventListener('dragstart', (event) => {
        if ((event.target as HTMLElement).closest('input,textarea,select')) { event.preventDefault(); return; }
        event.dataTransfer?.setData('text/plain', block.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', (event) => { if (editable) event.preventDefault(); });
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const id = event.dataTransfer?.getData('text/plain') || '', source = findStoryBlockLocation(blocks, id);
        if (source && source.siblings !== siblings) { announce('Drag within the current column. Use Move to column in module settings to move between columns.'); return; }
        move(id, index);
      });
      outline.append(item);
      for (const [col, children] of (block.content ?? []).entries()) renderList(children, col);
    } };
    renderList(blocks);
  }
  function update(block: StoryBlock, key: string, value: unknown, discrete = false) {
    if (!editable) return;
    remember(discrete ? '' : `${block.id}:${key}`);
    Object.assign(block, { [key]: value });
    sync(); renderOutline(); changed();
  }
  function field(block: StoryBlock, labelText: string, key: string, value: string, multiline = false) {
    const label = node('label', labelText);
    const input = multiline ? node('textarea') : node('input');
    if (input instanceof HTMLInputElement) input.type = 'text'; // the server validates addresses; a hidden type=url field must never block Save silently
    input.value = value;
    if (key === 'text' && block.type === 'text') input.placeholder = 'Start writing your story here…';
    input.dataset.moduleField = key;
    input.maxLength = key === 'alt' || block.type === 'heading' ? 300 : key === 'label' ? 120 : multiline ? 20000 : 2048;
    if (input instanceof HTMLTextAreaElement) input.rows = key === 'items' ? 6 : 9;
    input.addEventListener('input', () => update(block, key, key === 'items' ? input.value.split('\n') : input.value));
    label.append(input); fields.append(label);
    if (input instanceof HTMLTextAreaElement && key === 'text') {
      const tools = node('div', undefined, 'sb-controls');
      tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Module text formatting');
      for (const [name, before, after] of [['Bold', '**', '**'], ['Italic', '*', '*'], ['List', '\n- ', ''], ['Link', '[', ']']] as const) {
        tools.append(button(name, () => {
          let suffix: string = after;
          if (name === 'Link') {
            const url = window.prompt('Link address (https://…)', 'https://');
            if (!url) { input.focus(); return; }
            if (!isStoryButtonUrl(url.trim())) { announce('Use a safe web, mailto or tel link without embedded credentials.'); input.focus(); return; }
            suffix = `](${url.trim().replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
          }
          const start = input.selectionStart, end = input.selectionEnd;
          const selectedText = input.value.slice(start, end) || 'text';
          const value = input.value.slice(0, start) + before + selectedText + suffix + input.value.slice(end);
          try { checkStoryBlockLength(mapStoryBlocks(blocks, (b) => b.id === block.id ? { ...b, [key]: value } : b)); }
          catch (error) { announce(error instanceof Error ? error.message : 'The story is too long.'); input.focus(); return; }
          input.value = value; update(block, key, value, true); input.focus(); input.setSelectionRange(start + before.length, start + before.length + selectedText.length);
        }));
      }
      fields.append(tools);
    }
    return input;
  }
  function renderFields() {
    fields.replaceChildren();
    const location = findStoryBlockLocation(blocks, selected);
    const block = location?.siblings[location.index];
    if (!block) { title.textContent = 'Module settings'; fields.append(node('p', 'Choose a module, or add one to start your story.', 'admin-note')); return; }
    title.textContent = `${labels[block.type]} settings`;
    if (block.type === 'section') {
      const label = node('label', 'Section columns'), select = node('select'); select.setAttribute('aria-label', 'Section columns');
      for (const n of [1, 2]) { const option = node('option', `${n} ${n === 1 ? 'column' : 'columns'}`); option.value = String(n); option.selected = block.content?.length === n; select.append(option); }
      select.addEventListener('change', () => {
        const columns = block.content ?? [[]];
        remember(); block.content = Number(select.value) === 1 ? [columns.flat()] : columns.length === 1 ? [columns[0], []] : columns;
        render(); changed(); fields.querySelector<HTMLSelectElement>('[aria-label="Section columns"]')?.focus(); announce('Section columns updated; all content is preserved.');
      }); label.append(select); fields.append(label);
      for (const [i, column] of (block.content ?? []).entries()) {
        fields.append(node('p', `Column ${i + 1}: ${column.length} modules`, 'admin-note'));
        fields.append(button(`Add paragraph to column ${i + 1}`, () => {
          if (countStoryBlocks(blocks) >= STORY_BLOCK_LIMIT) { announce('A story can have up to 60 modules, including sections.'); return; }
          remember(); const added: StoryBlock = { id: uid(), type: 'text', text: '' }; column.push(added); selected = added.id; render(); changed(); fields.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        }));
      }
      fields.append(node('p', 'Columns read from left to right, then stack in that order on phones. Select a child module to insert beside it or move it to another column.', 'admin-note'));
    }
    if (location?.section) {
      const controls = node('div', undefined, 'sb-controls');
      for (const [i, column] of (location.section.content ?? []).entries()) if (i !== location.column) controls.append(button(`Move to column ${i + 1}`, () => {
        remember(); location.siblings.splice(location.index, 1); column.push(block); render(); changed(); focusSelected(); announce(`Module moved to column ${i + 1}.`);
      }));
      controls.append(button('Move outside section', () => { remember(); location.siblings.splice(location.index, 1); blocks.splice(blocks.indexOf(location.section!) + 1, 0, block); render(); changed(); focusSelected(); })); fields.append(controls);
    }
    if (block.type === 'text') {
      const start = node('div', undefined, 'sb-start-writing');
      start.id = 'module-start-writing';
      start.hidden = !(countStoryBlocks(blocks) === 1 && !block.text);
      start.append(node('p', 'Start writing your story. Your first paragraph is ready.'));
      start.append(button('Start writing', () => fields.querySelector<HTMLTextAreaElement>('textarea')?.focus()));
      fields.append(start);
    }
    if (['text', 'heading', 'quote'].includes(block.type)) field(block, block.type === 'heading' ? 'Heading text' : block.type === 'quote' ? 'Quote text' : 'Paragraph text (Markdown supported)', 'text', block.text || '', block.type !== 'heading');
    if (block.type === 'heading') {
      const label = node('label', 'Heading level');
      const select = node('select');
      for (const level of [2, 3]) { const option = node('option', `Heading ${level}`); option.value = String(level); option.selected = Number(block.level || 2) === level; select.append(option); }
      select.addEventListener('change', () => update(block, 'level', Number(select.value)));
      label.append(select); fields.append(label);
    }
    if (block.type === 'list') field(block, 'List items (one per line)', 'items', (block.items || []).join('\n'), true);
    if (block.type === 'button') {
      field(block, 'Link label', 'label', block.label || 'Read more');
      field(block, 'Link address (https://, mailto: or tel:)', 'url', block.url || '');
    }
    if (block.type === 'gallery') {
      fields.append(node('p', 'Choose at least two story photos. Their saved focal points and zoom are kept.', 'admin-note'));
      const choices = node('fieldset'); choices.append(node('legend', 'Gallery photos'));
      for (const [i, photo] of photos.entries()) {
        if (!photo.src) continue;
        const label = node('label', `${i + 1}. ${photo.alt || 'Story photo'}`);
        const input = node('input'); input.type = 'checkbox'; input.dataset.galleryPhoto = String(photo.id); input.checked = !!block.photos?.some((p) => p.photoId === photo.id);
        input.addEventListener('change', () => {
          const next = (block.photos ?? []).filter((p) => p.photoId !== photo.id);
          if (input.checked) next.push({ photoId: photo.id });
          update(block, 'photos', next); renderFields(); fields.querySelector<HTMLInputElement>(`[data-gallery-photo="${photo.id}"]`)?.focus();
        });
        label.prepend(input); choices.append(label);
      }
      fields.append(choices);
      const order = node('ol'); order.setAttribute('aria-label', 'Gallery photo order');
      for (const [i, ref] of (block.photos ?? []).entries()) {
        const row = node('li', photos.find((p) => p.id === ref.photoId)?.alt || `Photo ${i + 1}`);
        const reorder = (to: number) => {
          const next = [...(block.photos ?? [])]; [next[i], next[to]] = [next[to], next[i]];
          update(block, 'photos', next); renderFields();
          fields.querySelector<HTMLElement>(`[data-gallery-order="${to}"]`)?.focus();
        };
        const up = button('Earlier', () => reorder(i - 1), `Move gallery photo ${i + 1} earlier`); up.disabled = !editable || i === 0; row.dataset.galleryOrder = String(i); row.tabIndex = -1;
        const down = button('Later', () => reorder(i + 1), `Move gallery photo ${i + 1} later`); down.disabled = !editable || i === (block.photos?.length ?? 0) - 1;
        row.append(up, down); order.append(row);
      }
      fields.append(order);
      const label = node('label', 'Gallery columns'), select = node('select'); select.dataset.moduleField = 'columns'; select.setAttribute('aria-label', 'Gallery columns');
      for (const n of [2, 3]) { const option = node('option', `${n} columns`); option.value = String(n); option.selected = (block.columns ?? 2) === n; select.append(option); }
      select.addEventListener('change', () => update(block, 'columns', Number(select.value))); label.append(select); fields.append(label);
    }
    if (block.type === 'video') {
      field(block, 'Video title', 'label', block.label || '');
      field(block, 'YouTube or Vimeo URL (HTTPS)', 'url', block.url || '');
      fields.append(node('p', 'Paste the video link. Readers press Play to open an embedded video popup. Private preview shows a safe provider link.', 'admin-note'));
    }
    if (['image', 'flyer'].includes(block.type)) {
      const label = node('label', 'Story photo');
      const select = node('select'); select.dataset.moduleField = 'photoId';
      const placeholder = node('option', 'Choose a photo'); placeholder.value = ''; select.append(placeholder);
      for (const [i, photo] of photos.entries()) { if (!photo.src) continue; const option = node('option', `${i + 1}. ${photo.alt || 'Story photo'}`); option.value = String(photo.id); option.selected = photo.id === block.photoId; select.append(option); }
      select.addEventListener('change', () => {
        update(block, 'photoId', select.value ? Number(select.value) : undefined);
        renderFields();
        fields.querySelector<HTMLSelectElement>('[data-module-field="photoId"]')?.focus();
      });
      label.append(select); fields.append(label);
      const photo = photos.find((p) => p.id === block.photoId);
      if (photo?.src) { const img = node('img'); img.src = photo.src; img.alt = block.alt || photo.alt; img.className = 'sb-module-image'; fields.append(img); }
      if (block.type === 'image' && !location?.section) {
        const sizeLabel = node('label', 'Size and alignment');
        const size = node('select'); size.dataset.moduleField = 'placement';
        for (const [value, text] of [['', 'Column width'], ['wide', 'Wide'], ['full', 'Full width'], ['left', 'Left, text wraps'], ['right', 'Right, text wraps']] as const) { const option = node('option', text); option.value = value; option.selected = (block.placement ?? '') === value; size.append(option); }
        size.disabled = !editable;
        size.addEventListener('change', () => update(block, 'placement', size.value || undefined, true));
        sizeLabel.append(size); fields.append(sizeLabel);
        fields.append(node('p', 'Left and right sit beside the text on screens 768px and wider. On narrower screens the photo is shown at the full column width.', 'admin-note'));
      } else if (block.type === 'image') fields.append(node('p', 'Size and alignment is available for photos outside sections.', 'admin-note'));
      field(block, 'Image description (alt text)', 'alt', block.alt || '');
      if (block.type === 'flyer') fields.append(node('p', 'Leave the description empty to follow the current photo description in Photo studio.', 'admin-note'));
      fields.append(node('p', block.type === 'flyer' ? 'Flyers show the whole image so its text stays visible. Add a text summary to the story for accessibility.' : 'This photo appears here in the story text. Adjust its focal point in the Photo studio.', 'admin-note'));
      fields.append(button('Open Photo studio', () => setPanel('photos', true)));
    }
    if (block.type === 'divider') fields.append(node('p', 'A simple divider gives the next part of your story room to breathe.', 'admin-note'));
    const settings = node('div', undefined, 'sb-controls');
    for (const [key, name, values] of [
      ...(['text', 'heading', 'quote', 'list', 'button'].includes(block.type) ? [['align', 'Text alignment', [['', 'Default (left)'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']]]] : []),
      ['spacing', 'Module spacing', [['', 'Default'], ['compact', 'Compact'], ['normal', 'Normal'], ['relaxed', 'Relaxed']]],
    ] as [string, string, [string, string][]][]) {
      const label = node('label', name), select = node('select'); select.setAttribute('aria-label', name); select.dataset.moduleField = key;
      for (const [value, text] of values) { const option = node('option', text); option.value = value; option.selected = ((block as unknown as Record<string, unknown>)[key] ?? '') === value; select.append(option); }
      select.addEventListener('change', () => update(block, key, select.value || undefined, true)); label.append(select); settings.append(label);
    }
    fields.append(settings);
    const actions = node('div', undefined, 'sb-controls');
    actions.append(button('Duplicate module', () => {
      if (countStoryBlocks(blocks) + countStoryBlocks([block]) > STORY_BLOCK_LIMIT) { announce('A story can have up to 60 modules, including sections.'); return; }
      remember(); const copy = mapStoryBlocks(clone([block]), (b) => ({ ...b, id: uid() }))[0]; location!.siblings.splice(location!.index + 1, 0, copy); selected = copy.id; render(); focusSelected(); changed(); announce('Module duplicated.');
    }), button('Delete module', () => {
      if (!window.confirm(`Delete this ${labels[block.type].toLowerCase()} module? You can undo this change.`)) return;
      remember(); const at = location!.index, siblings = location!.siblings; siblings.splice(at, 1); selected = siblings[Math.min(at, siblings.length - 1)]?.id || location!.section?.id || '';  render(); focusSelected(); changed(); announce('Module deleted. Use Undo module change to restore it.');
    }));
    fields.append(actions);
  }
  function render() { sync(); renderOutline(); renderFields(); }
  function syncPanes() {
    inspector.hidden = !modular;
    inspector.inert = !modular;
  }
  const librarySearch = document.getElementById('module-library-search') as HTMLInputElement;
  const libraryReset = document.getElementById('module-library-reset') as HTMLButtonElement;
  const libraryCategory = document.getElementById('module-library-category') as HTMLSelectElement;
  const pinKey = 'imconnected-module-pins-v1';
  let pinned = new Set(['text', 'image', 'button']);
  try { const saved = JSON.parse(localStorage.getItem(pinKey) ?? 'null'); if (Array.isArray(saved)) pinned = new Set(saved.filter((v) => typeof v === 'string' && Object.hasOwn(labels, v))); } catch { /* preferences never affect story access */ }
  for (const pin of document.querySelectorAll<HTMLInputElement>('[data-pin-module]')) {
    pin.checked = pinned.has(pin.dataset.pinModule!);
    pin.addEventListener('input', (e) => e.stopPropagation());
    pin.addEventListener('change', (e) => {
      e.stopPropagation(); if (pin.checked) pinned.add(pin.dataset.pinModule!); else pinned.delete(pin.dataset.pinModule!);
      let saved = true; try { localStorage.setItem(pinKey, JSON.stringify([...pinned])); } catch { saved = false; }
      document.getElementById('module-pin-status')!.textContent = saved ? 'Quick access saved.' : 'Quick access changed for this visit; browser storage is unavailable.';
      filterLibrary();
    });
  }
  function filterLibrary() {
    const query = librarySearch.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const add of document.querySelectorAll<HTMLButtonElement>('[data-add-module]')) {
      const category = libraryCategory.value;
      const matchesQuery = `${add.textContent} ${add.dataset.addModule}`.toLocaleLowerCase().includes(query) && (category === 'all' || category === 'favorites' && pinned.has(add.dataset.addModule!) || add.dataset.libraryCategory === category);
      add.hidden = !matchesQuery;
      if (matchesQuery) matches++;
    }
    document.getElementById('module-library-results')!.textContent = `${matches} ${matches === 1 ? 'module' : 'modules'}${query ? ' found' : ''}`;
    document.getElementById('module-library-empty')!.hidden = matches > 0;
    libraryReset.hidden = !librarySearch.value && libraryCategory.value === 'all';
  }
  librarySearch.addEventListener('input', (event) => { event.stopPropagation(); filterLibrary(); });
  libraryReset.addEventListener('click', () => { librarySearch.value = ''; libraryCategory.value = 'all'; filterLibrary(); librarySearch.focus(); });
  libraryCategory.addEventListener('input', (e) => e.stopPropagation());
  libraryCategory.addEventListener('change', (e) => { e.stopPropagation(); filterLibrary(); });
  const layouts: Record<string, { label: string; types: StoryBlock['type'][] }> = {
    news: { label: 'News story', types: ['text', 'heading', 'text', 'quote'] },
    recap: { label: 'Event recap', types: ['heading', 'text', 'list', 'text'] },
    announcement: { label: 'Announcement', types: ['heading', 'text', 'list', 'divider'] },
  };
  for (const insert of document.querySelectorAll<HTMLButtonElement>('[data-insert-layout]')) insert.addEventListener('click', () => {
    if (!editable || !modular) return;
    const layout = layouts[insert.dataset.insertLayout || ''];
    if (!layout) return;
    if (countStoryBlocks(blocks) + layout.types.length > STORY_BLOCK_LIMIT) {
      announce(`${layout.label} needs ${layout.types.length} spaces. A story can have up to ${STORY_BLOCK_LIMIT} modules. No modules were added.`);
      return;
    }
    const added = layout.types.map((type): StoryBlock => ({ id: uid(), type,
      ...(['text', 'heading', 'quote'].includes(type) ? { text: '' } : {}),
      ...(type === 'heading' ? { level: 2 as const } : {}),
      ...(type === 'list' ? { items: [''] } : {}),
    }));
    remember();
    const at = findStoryBlockLocation(blocks, selected);
    (at?.siblings ?? blocks).splice(at ? at.index + 1 : blocks.length, 0, ...added);
    selected = added[0].id;
    render(); changed();
    fields.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    announce(`${layout.label} inserted after the selected module. ${added.length} empty modules added; existing content is kept.`);
  });
  const layoutName = document.getElementById('saved-layout-name') as HTMLInputElement;
  layoutName.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); document.getElementById('save-story-layout')?.click(); } });
  const layoutChoice = document.getElementById('saved-layout-choice') as HTMLSelectElement;
  const layoutStatus = document.getElementById('saved-layout-status')!;
  let savedLayouts: { id: number; name: string; blocks: StoryBlock[] }[] = [];
  async function loadLayouts(selectedId?: number) {
    try {
      const response = await fetch('/api/admin/layouts', { credentials: 'same-origin' }); const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load saved layouts.');
      savedLayouts = data.layouts; layoutChoice.replaceChildren();
      const empty = node('option', savedLayouts.length ? 'Choose a layout' : 'No saved layouts yet'); empty.value = ''; layoutChoice.append(empty);
      for (const layout of savedLayouts) { const option = node('option', layout.name); option.value = String(layout.id); layoutChoice.append(option); }
      if (selectedId) layoutChoice.value = String(selectedId);
    } catch (error) { layoutStatus.textContent = error instanceof Error ? error.message : 'Could not load saved layouts.'; }
  }
  async function layoutPost(form: FormData) {
    const response = await fetch('/api/admin/layouts', { method: 'POST', body: form, credentials: 'same-origin' }); const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not save the layout.'); return data;
  }
  document.getElementById('save-story-layout')?.addEventListener('click', async () => {
    if (!editable || !modular || !countStoryBlocks(blocks)) return;
    const form = new FormData(); form.set('op', 'save'); form.set('name', layoutName.value); form.set('blocks', JSON.stringify(blocks));
    try { const data = await layoutPost(form); await loadLayouts(data.id); layoutStatus.textContent = 'Structure saved. Add content when you reuse it.'; }
    catch (error) { layoutStatus.textContent = error instanceof Error ? error.message : 'Could not save the layout.'; }
  });
  document.getElementById('insert-story-layout')?.addEventListener('click', () => {
    const layout = savedLayouts.find((l) => l.id === Number(layoutChoice.value));
    if (!editable || !modular || !layout) { layoutStatus.textContent = 'Choose a saved layout first.'; return; }
    if (countStoryBlocks(blocks) + countStoryBlocks(layout.blocks) > STORY_BLOCK_LIMIT) { announce('This layout would exceed the 60-module limit. No modules were added.'); return; }
    const added = mapStoryBlocks(clone(layout.blocks), (b) => ({ ...b, id: uid() }));
    const at = findStoryBlockLocation(blocks, selected);
    // A structure containing sections stays at the root; sections cannot nest.
    const target = added.some((b) => b.type === 'section') && at?.section ? findStoryBlockLocation(blocks, at.section.id) : at;
    remember(); (target?.siblings ?? blocks).splice(target ? target.index + 1 : blocks.length, 0, ...added); selected = added[0].id;
    render(); changed(); focusSelected(); announce('Saved structure inserted. Fill in its content and choose photos.');
  });
  document.getElementById('delete-story-layout')?.addEventListener('click', async () => {
    if (!editable || !layoutChoice.value || !window.confirm('Delete this saved layout?')) return;
    const form = new FormData(); form.set('op', 'delete'); form.set('id', layoutChoice.value);
    try { await layoutPost(form); await loadLayouts(); layoutStatus.textContent = 'Saved layout deleted.'; }
    catch (error) { layoutStatus.textContent = error instanceof Error ? error.message : 'Could not delete the layout.'; }
  });
  void loadLayouts();
  useModules.addEventListener('click', () => {
    if (!editable || modular) return;
    remember(); modular = true;
    blocks = splitMarkdownIntoModules(body.value).map((text) => ({ id: uid(), type: 'text' as const, text }));
    selected = blocks[0].id;
    render(); changed(); announce('Modules enabled. Your existing Markdown is preserved in the first paragraph module.');
  });
  useMarkdown.addEventListener('click', () => {
    if (!editable || !modular) return;
    if (!window.confirm('Switch to Markdown? Text and links are kept. Images stay in Photos and use the photo layout instead of their inline positions. You can undo this change before leaving.')) return;
    let projection: string;
    try { projection = storyBlocksToMarkdown(blocks); }
    catch (error) { announce(error instanceof Error ? error.message : 'Check the modules first.'); return; }
    remember(); body.value = projection; modular = false; blocks = []; selected = ''; render(); changed(); announce('Markdown mode enabled.');
  });
  for (const add of document.querySelectorAll<HTMLButtonElement>('[data-add-module]')) add.addEventListener('click', () => {
    if (!editable || !modular) return;
    if (countStoryBlocks(blocks) >= STORY_BLOCK_LIMIT) { announce('A story can have up to 60 modules.'); return; }
    const type = add.dataset.addModule as StoryBlock['type'];
    if (['image', 'gallery', 'flyer'].includes(type) && !photos.some((p) => p.src)) return;
    if (type === 'section' && countStoryBlocks(blocks) + 3 > STORY_BLOCK_LIMIT) { announce('A two-column section needs three module spaces.'); return; }
    remember();
    const block: StoryBlock = { id: uid(), type };
    if (['text', 'heading', 'quote'].includes(type)) block.text = '';
    if (type === 'heading') block.level = 2;
    if (type === 'list') block.items = [''];
    if (type === 'button') { block.label = 'Read more'; block.url = ''; }
    if (type === 'gallery') { block.columns = 2; block.photos = photos.filter((p) => p.src).map((p) => ({ photoId: p.id })); }
    if (type === 'section') {
      block.content = [[{ id: uid(), type: 'text', text: '' }], [{ id: uid(), type: 'text', text: '' }]];
    }
    if (type === 'video') { block.label = 'Event video'; block.url = ''; }
    if (['image', 'flyer'].includes(type)) { block.photoId = photos.find((p) => p.src)!.id; if (type === 'image') block.alt = photos.find((p) => p.id === block.photoId)?.alt || ''; }
    const at = type === 'section' ? undefined : findStoryBlockLocation(blocks, selected);
    const rootIndex = type === 'section' ? blocks.findIndex((b) => b.id === selected || b.content?.flat().some((c) => c.id === selected)) : -1;
    (at?.siblings ?? blocks).splice(at ? at.index + 1 : rootIndex >= 0 ? rootIndex + 1 : blocks.length, 0, block); selected = block.id;
    render(); changed(); announce(`${labels[type]} module added.`);
    fields.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
  });
  function restore(raw: string) {
    const state = JSON.parse(raw); blocks = state.blocks; modular = state.modular; body.value = state.body; selected = state.selected || blocks[0]?.id || '';
    editKey = ''; render(); focusSelected(); changed();
  }
  undo.addEventListener('click', () => { if (!editable || !history.length) return; future.push(snapshot()); restore(history.pop()!); announce('Module change undone.'); });
  redo.addEventListener('click', () => { if (!editable || !future.length) return; history.push(snapshot()); restore(future.pop()!); announce('Module change restored.'); });
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-preview-width]')) control.addEventListener('click', () => {
    const preview = document.getElementById('preview')!;
    preview.classList.toggle('sb-phone-preview', control.dataset.previewWidth === 'phone');
    for (const other of document.querySelectorAll('[data-preview-width]')) other.setAttribute('aria-pressed', String(other === control));
  });
  const previewFrame = document.getElementById('preview') as HTMLIFrameElement;
  function highlightCanvas() {
    const doc = (document.getElementById('preview') as HTMLIFrameElement)?.contentDocument;
    for (const module of doc?.querySelectorAll<HTMLElement>('[data-module-id]') || []) {
      const active = editable && modular && module.dataset.moduleId === selected;
      module.toggleAttribute('data-preview-selected', active);
      module.style.outline = active ? '3px solid #087e8b' : '';
      module.style.outlineOffset = active ? '5px' : '';
    }
  }
  previewFrame.addEventListener('load', () => {
    const doc = previewFrame.contentDocument;
    if (!doc) return;
    // The parent owns these DOM controls; the sandbox never gains script permission.
    if (editable && modular) for (const module of doc.querySelectorAll<HTMLElement>('[data-module-id]')) {
      const flattened = walkStoryBlocks(blocks);
      const index = flattened.findIndex((block) => block.id === module.dataset.moduleId);
      if (index < 0) continue;
      module.tabIndex = 0;
      module.setAttribute('aria-description', `${labels[flattened[index].type]} module ${index + 1}. Press Enter or Space to edit.`);
      module.title = 'Select this module to edit its settings';
      module.style.cursor = 'pointer';
      module.style.minHeight = '24px';
    }
    highlightCanvas();
    revealPart(activePanel === 'content' ? 'module' : activePanel);
    const selectFromCanvas = (target: Element) => {
      if (!editable || !modular) return;
      const id = target.closest<HTMLElement>('[data-module-id]')?.dataset.moduleId;
      if (!id || !walkStoryBlocks(blocks).some((block) => block.id === id)) return;
      selected = id;
      setPanel('content');
      render();
      fields.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
      announce('Module selected from the canvas. Its settings are ready to edit.');
    };
    doc.addEventListener('click', (event) => {
      const target = event.target as Element;
      if (target.closest('a')) event.preventDefault();
      selectFromCanvas(target);
    });
    doc.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target as Element;
      if (target.closest('a')) event.preventDefault();
      if (!editable || !modular || !target.closest('[data-module-id]')) return;
      event.preventDefault();
      selectFromCanvas(target);
    });
  });

  function updateFocus(id: number, x: number, y: number, notify = true) {
    if (!editable || photos.find((p) => p.id === id)?.fit === 'contain') return; // a whole-photo fit has no pan
    x = Math.round(Math.max(0, Math.min(100, x)) * 100) / 100; y = Math.round(Math.max(0, Math.min(100, y)) * 100) / 100;
    const xInput = form!.elements.namedItem(`photo_${id}_focalX`) as HTMLInputElement;
    const yInput = form!.elements.namedItem(`photo_${id}_focalY`) as HTMLInputElement;
    if (!xInput || !yInput) return;
    xInput.value = String(x); yInput.value = String(y);
    const surface = document.querySelector<HTMLElement>(`[data-focal="${id}"]`);
    const marker = surface?.querySelector<HTMLElement>('.sb-focal-marker');
    if (marker) { marker.style.left = `${x}%`; marker.style.top = `${y}%`; }
    const photo = photos.find((p) => p.id === id);
    for (const img of document.querySelectorAll<HTMLElement>(`[data-focus-preview="${id}"]`)) {
      img.style.objectPosition = `${x}% ${y}%`;
      img.style.scale = (photo?.zoom ?? 1) === 1 ? '' : String(photo!.zoom);
      img.style.transformOrigin = `${x}% ${y}%`;
    }
    const output = document.querySelector(`[data-focus-output="${id}"]`);
    if (output) output.textContent = `${x}% horizontal, ${y}% vertical`;
    if (photo) { photo.focalX = x; photo.focalY = y; }
    if (notify) changed();
  }
  for (const surface of document.querySelectorAll<HTMLElement>('[data-focal]')) {
    const id = Number(surface.dataset.focal);
    const fromPoint = (event: PointerEvent) => { const rect = surface.getBoundingClientRect(); updateFocus(id, (event.clientX - rect.left) / rect.width * 100, (event.clientY - rect.top) / rect.height * 100); };
    let dragging = false;
    surface.addEventListener('pointerdown', (event) => { if (!editable || event.button !== 0) return; event.preventDefault(); dragging = true; surface.setPointerCapture(event.pointerId); surface.focus(); fromPoint(event); });
    surface.addEventListener('pointermove', (event) => { if (dragging) fromPoint(event); });
    surface.addEventListener('pointerup', () => { dragging = false; });
    surface.addEventListener('pointercancel', () => { dragging = false; });
    surface.addEventListener('keydown', (event) => {
      const directions: Record<string, number[]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const step = directions[event.key]; if (!step || !editable) return;
      event.preventDefault(); const photo = photos.find((p) => p.id === id)!; const amount = event.shiftKey ? 10 : 1;
      updateFocus(id, photo.focalX + step[0] * amount, photo.focalY + step[1] * amount);
    });
    for (const axis of ['X', 'Y']) (form.elements.namedItem(`photo_${id}_focal${axis}`) as HTMLInputElement)?.addEventListener('input', () => {
      const x = Number((form.elements.namedItem(`photo_${id}_focalX`) as HTMLInputElement).value);
      const y = Number((form.elements.namedItem(`photo_${id}_focalY`) as HTMLInputElement).value);
      updateFocus(id, x, y, false);
    });
  }
  for (const center of document.querySelectorAll<HTMLButtonElement>('[data-center-focus]')) center.addEventListener('click', () => updateFocus(Number(center.dataset.centerFocus), 50, 50));
  function updateZoom(id: number, value: number, notify = true) {
    if (!editable) return;
    const photo = photos.find((p) => p.id === id);
    const input = form!.elements.namedItem(`photo_${id}_zoom`) as HTMLInputElement;
    if (!photo || !input || photo.fit === 'contain') return;
    photo.zoom = Math.round(Math.max(1, Math.min(3, value)) * 100) / 100;
    input.value = String(photo.zoom);
    input.setAttribute('aria-valuetext', `${Math.round(photo.zoom * 100)} percent`);
    const output = document.querySelector(`[data-zoom-output="${id}"]`);
    if (output) output.textContent = `${Math.round(photo.zoom * 100)}%`;
    updateFocus(id, photo.focalX, photo.focalY, notify);
  }
  for (const photo of photos) {
    (form.elements.namedItem(`photo_${photo.id}_zoom`) as HTMLInputElement)?.addEventListener('input', (event) => updateZoom(photo.id, Number((event.target as HTMLInputElement).value), false));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-zoom-photo]')) button.addEventListener('click', () => {
    const photo = photos.find((p) => p.id === Number(button.dataset.zoomPhoto));
    if (photo) updateZoom(photo.id, photo.zoom + Number(button.dataset.zoomStep));
  });
  for (const reset of document.querySelectorAll<HTMLButtonElement>('[data-reset-crop]')) reset.addEventListener('click', () => {
    const id = Number(reset.dataset.resetCrop);
    updateZoom(id, 1, false); updateFocus(id, 50, 50);
  });
  // Fit whole photo: show the entire image over a fill; zoom and pan are turned off (native disabled, so older values are kept) and the preview follows live.
  function applyFit(id: number, notify = true) {
    const photo = photos.find((p) => p.id === id);
    const toggle = document.querySelector<HTMLInputElement>(`[data-fit-toggle="${id}"]`);
    if (!photo || !toggle) return;
    const whole = toggle.checked;
    photo.fit = whole ? 'contain' : 'cover';
    const checkedFill = document.querySelector<HTMLInputElement>(`[data-fit-fill-group="${id}"] input:checked`);
    photo.fitFill = (checkedFill?.value as Photo['fitFill']) || 'blur';
    const group = document.querySelector<HTMLFieldSetElement>(`[data-fit-fill-group="${id}"]`);
    if (group) group.disabled = !whole || !editable;
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(`[name="photo_${id}_focalX"],[name="photo_${id}_focalY"],[name="photo_${id}_zoom"],[data-zoom-photo="${id}"],[data-center-focus="${id}"],[data-reset-crop="${id}"]`)) control.disabled = whole || !editable;
    for (const surface of document.querySelectorAll<HTMLElement>(`[data-pan-photo="${id}"],[data-focal="${id}"]`)) {
      if (whole) surface.setAttribute('aria-disabled', 'true'); else surface.removeAttribute('aria-disabled');
      surface.tabIndex = editable && !whole ? 0 : -1;
    }
    const frame = document.querySelector<HTMLElement>(`[data-pan-photo="${id}"]`);
    if (frame) {
      if (whole) {
        frame.dataset.fit = 'contain'; frame.dataset.fitFill = photo.fitFill ?? 'blur';
        if (photo.fitFill === 'blur') frame.style.setProperty('--fit-src', `url(${JSON.stringify(photo.src)})`); else frame.style.removeProperty('--fit-src');
      } else { delete frame.dataset.fit; delete frame.dataset.fitFill; frame.style.removeProperty('--fit-src'); }
    }
    // The crop's inline pan and zoom are dropped while the whole photo is shown and restored from the saved values when it is switched off.
    for (const img of document.querySelectorAll<HTMLElement>(`[data-focus-preview="${id}"]`)) {
      if (whole) { img.style.objectPosition = ''; img.style.scale = ''; img.style.transformOrigin = ''; }
      else { img.style.objectFit = ''; img.style.objectPosition = `${photo.focalX}% ${photo.focalY}%`; img.style.scale = photo.zoom === 1 ? '' : String(photo.zoom); img.style.transformOrigin = `${photo.focalX}% ${photo.focalY}%`; }
    }
    const note = document.querySelector(`[data-pan-note="${id}"]`);
    if (note) note.textContent = whole ? 'The whole photo is shown, so there is nothing to pan.' : 'Drag the crop to move the image. Arrow keys pan; Shift moves faster.';
    const live = document.querySelector(`[data-focus-output="${id}"]`);
    if (live && whole) live.textContent = 'Whole photo shown. Zoom and pan are off.';
    else if (live) live.textContent = `${photo.focalX}% horizontal, ${photo.focalY}% vertical`;
    if (notify) changed();
  }
  for (const toggle of document.querySelectorAll<HTMLInputElement>('[data-fit-toggle]')) {
    const id = Number(toggle.dataset.fitToggle);
    toggle.addEventListener('change', () => applyFit(id));
    for (const radio of document.querySelectorAll<HTMLInputElement>(`[data-fit-fill-group="${id}"] input`)) radio.addEventListener('change', () => applyFit(id));
  }
  for (const surface of document.querySelectorAll<HTMLElement>('[data-pan-photo]')) {
    const photo = photos.find((p) => p.id === Number(surface.dataset.panPhoto));
    const image = surface.querySelector('img')!;
    if (!photo) continue;
    let start: { x: number; y: number; focalX: number; focalY: number; overflowX: number; overflowY: number } | undefined;
    surface.addEventListener('pointerdown', (event) => {
      if (!editable || photo.fit === 'contain' || event.button !== 0 || !image.naturalWidth || !image.naturalHeight) return;
      const rect = surface.getBoundingClientRect();
      const cover = Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight) * photo.zoom;
      start = { x: event.clientX, y: event.clientY, focalX: photo.focalX, focalY: photo.focalY,
        overflowX: Math.max(0, image.naturalWidth * cover - rect.width), overflowY: Math.max(0, image.naturalHeight * cover - rect.height) };
      event.preventDefault(); surface.focus(); surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener('pointermove', (event) => {
      if (!start) return;
      updateFocus(photo.id,
        start.overflowX > .5 ? start.focalX - (event.clientX - start.x) / start.overflowX * 100 : start.focalX,
        start.overflowY > .5 ? start.focalY - (event.clientY - start.y) / start.overflowY * 100 : start.focalY);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(name, () => { start = undefined; });
    surface.addEventListener('keydown', (event) => {
      const direction: Record<string, number[]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      const step = direction[event.key];
      if (!editable || !step) return;
      event.preventDefault(); const amount = event.shiftKey ? 10 : 1;
      updateFocus(photo.id, photo.focalX + step[0] * amount, photo.focalY + step[1] * amount);
    });
  }
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-studio-panel]'));
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-studio-tab]'));
  const studio = document.querySelector<HTMLElement>('.editor-studio');
  const previewCard = document.getElementById('ed-preview-card');
  const outlineCard = document.getElementById('ed-outline');
  studio?.setAttribute('data-js', '');
  if (outlineCard) outlineCard.hidden = false;
  if (previewCard) previewCard.hidden = false;
  // The outline marks the open part with aria-current: the static parts, "Body text", or the selected module.
  function markCurrent() {
    for (const tab of tabs) {
      const current = tab.dataset.studioTab === activePanel && !(activePanel === 'content' && modular);
      if (current) tab.setAttribute('aria-current', 'true'); else tab.removeAttribute('aria-current');
    }
    for (const module of outline.querySelectorAll<HTMLElement>('[data-select-module]')) {
      if (activePanel === 'content' && module.dataset.selectModule === selected) module.setAttribute('aria-current', 'true'); else module.removeAttribute('aria-current');
    }
  }
  // Selecting a part scrolls the private preview to it when it can (the preview is a same-origin, script-disabled frame).
  function revealPart(part: string) {
    const doc = previewFrame.contentDocument, win = previewFrame.contentWindow;
    if (!doc || !win || !doc.body) return;
    let target: Element | null = null;
    if (part === 'module') target = modular ? doc.querySelector(`[data-module-id="${CSS.escape(selected)}"]`) : null;
    else if (part === 'photos') target = doc.querySelector('.story-photos, .photos, figure, article img');
    else if (part === 'settings') { win.scrollTo({ top: 0 }); return; }
    if (!target) return;
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > win.innerHeight) win.scrollTo({ top: Math.max(0, box.top + win.scrollY - 72) });
  }
  function setPanel(name: string, focus = false) {
    if (!panels.some((panel) => panel.dataset.studioPanel === name)) name = 'content';
    activePanel = name;
    for (const panel of panels) {
      const active = panel.dataset.studioPanel === name;
      panel.hidden = !active; panel.inert = !active;
    }
    markCurrent();
    studio?.setAttribute('data-active-panel', name);
    if (focus) panels.find((panel) => panel.dataset.studioPanel === name)?.querySelector<HTMLElement>('[data-panel-heading]')?.focus();
    if (window.location.hash !== `#${name}`) window.history.replaceState(null, '', `#${name}`);
    if (name !== 'content') revealPart(name);
  }
  for (const tab of tabs) tab.addEventListener('click', () => { setPanel(tab.dataset.studioTab!, true); if (tab.dataset.studioTab === 'content') revealPart('module'); });
  // "Add to the story" opens the module library (module stories only).
  document.getElementById('outline-add')?.addEventListener('click', () => {
    if (!editable || !modular) return;
    setPanel('content'); library.open = true;
    (document.getElementById('module-library-search') as HTMLElement | null)?.focus();
    library.scrollIntoView({ block: 'start' });
  });
  // Never a hidden input (the version and storyBlocks fields come first in their forms) or a disabled control.
  const FOCUSABLE = 'input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary';
  for (const control of document.querySelectorAll<HTMLElement>('[data-open-panel]')) control.addEventListener('click', (event) => {
    const hash = control instanceof HTMLAnchorElement ? control.getAttribute('href') : null;
    if (hash?.startsWith('#')) event.preventDefault();
    control.closest('details')?.removeAttribute('open');
    setPanel(control.dataset.openPanel!, !hash);
    if (control.dataset.openDetails) { const details = document.getElementById(control.dataset.openDetails); if (details instanceof HTMLDetailsElement) details.open = true; }
    const target = hash && hash.length > 1 ? document.querySelector<HTMLElement>(hash) : null;
    if (!target) return;
    const heading = target.closest('[data-studio-panel]')?.querySelector<HTMLElement>('[data-panel-heading]');
    (target.matches(FOCUSABLE) ? target : (target instanceof HTMLDetailsElement ? target.querySelector<HTMLElement>('textarea:not(:disabled)') : null) ?? target.querySelector<HTMLElement>(FOCUSABLE) ?? heading)?.focus();
    target.scrollIntoView({ block: 'center' });
  });
  // The Publish menu closes on Escape (focus returns to its toggle), when focus leaves it, and on an outside click.
  const publishMenu = document.querySelector<HTMLDetailsElement>('.ed-menu');
  if (publishMenu) {
    publishMenu.addEventListener('keydown', (event) => { if (event.key === 'Escape' && publishMenu.open) { publishMenu.open = false; publishMenu.querySelector('summary')?.focus(); } });
    publishMenu.addEventListener('focusout', (event) => { const next = event.relatedTarget as Node | null; if (publishMenu.open && next && !publishMenu.contains(next)) publishMenu.open = false; });
    document.addEventListener('click', (event) => { if (publishMenu.open && !publishMenu.contains(event.target as Node)) publishMenu.open = false; });
  }
  const saveStatus = document.getElementById('save-status');
  const mobileSaveStatus = document.querySelector('[data-mobile-save-status]');
  if (saveStatus && mobileSaveStatus) {
    const reflectStatus = () => { mobileSaveStatus.textContent = saveStatus.textContent; };
    reflectStatus();
    new MutationObserver(reflectStatus).observe(saveStatus, { childList: true, subtree: true, characterData: true });
  }
  const narrow = window.matchMedia('(max-width: 767px)');
  // On a phone the preview opens as a full-screen view: everything behind it is inert while it is open, and the closed card is inert too.
  let background: HTMLElement[] = [];
  function setPreviewOpen(open: boolean) {
    if (!previewCard) return;
    for (const el of background) el.inert = false;
    background = [];
    if (open) previewCard.dataset.open = 'true'; else delete previewCard.dataset.open;
    previewCard.inert = narrow.matches && !open;
    if (!open || !narrow.matches) return;
    for (let el: HTMLElement = previewCard; el.parentElement && el !== document.body; el = el.parentElement) {
      for (const sibling of Array.from(el.parentElement.children) as HTMLElement[]) if (sibling !== el && !sibling.inert && !['SCRIPT', 'STYLE'].includes(sibling.tagName)) { sibling.inert = true; background.push(sibling); }
    }
  }
  narrow.addEventListener('change', () => setPreviewOpen(false));
  setPreviewOpen(false);
  for (const control of document.querySelectorAll('[data-studio-preview]')) control.addEventListener('click', () => {
    // Three and two columns keep the preview beside the editor; on phones it opens as its own view.
    if (narrow.matches) setPreviewOpen(true);
    previewCard?.scrollIntoView({ block: 'start' });
    if (narrow.matches) previewCard?.querySelector<HTMLElement>('[data-preview-close]')?.focus(); else previewFrame.focus();
  });
  const closePreview = () => { setPreviewOpen(false); (document.querySelector('[data-studio-preview]') as HTMLElement | null)?.focus(); };
  for (const close of document.querySelectorAll('[data-preview-close]')) close.addEventListener('click', closePreview);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && narrow.matches && previewCard?.dataset.open) closePreview(); });
  form.addEventListener('input', () => {
    const storyTitle = (form.elements.namedItem('title') as HTMLInputElement)?.value.trim() || 'Untitled story';
    const author = (form.elements.namedItem('author') as HTMLInputElement)?.value.trim() || 'Add an author in Story settings';
    const heading = document.querySelector('.studio-title-line h1'); if (heading) heading.textContent = storyTitle;
    const reviewTitle = document.querySelector('[data-review-title]'); if (reviewTitle) reviewTitle.textContent = storyTitle;
    const reviewAuthor = document.querySelector('[data-review-author]'); if (reviewAuthor) reviewAuthor.textContent = author;
    // Keep the outline's meta lines, dots and the status strip in step with what is typed.
    const value = (name: string) => ((form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '').trim();
    const sectionSelect = form.elements.namedItem('section') as HTMLSelectElement | null, areaSelect = form.elements.namedItem('area') as HTMLSelectElement | null;
    const area = areaSelect?.value && !areaSelect.selectedOptions[0]?.hidden ? areaSelect.selectedOptions[0]?.textContent ?? '' : '';
    const eyebrow = sectionSelect?.value ? [sectionSelect.selectedOptions[0]?.textContent, area].filter(Boolean).join(' · ') : 'Draft';
    for (const el of document.querySelectorAll('[data-editor-eyebrow]')) el.textContent = eyebrow;
    const detailsMeta = document.querySelector('[data-meta="settings"]'); if (detailsMeta) detailsMeta.textContent = sectionSelect?.value ? eyebrow : 'Headline · summary · section';
    const words = body.value.trim() ? body.value.trim().split(/\s+/).length : 0;
    const bodyMeta = document.querySelector('[data-meta="body"]'); if (bodyMeta) bodyMeta.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
    const missing: Record<string, boolean> = { title: !value('title'), author: !value('author'), section: !value('section'), date: !value('date'), body: !body.value.trim() && blocksField.value === '[]' };
    for (const li of document.querySelectorAll<HTMLElement>('[data-problem]')) li.hidden = !missing[li.dataset.problem!];
    const list = document.querySelector<HTMLElement>('.ed-problems'), ok = document.querySelector<HTMLElement>('.ed-ok');
    if (list && ok) { const any = Array.from(list.children).some((li) => !(li as HTMLElement).hidden); list.hidden = !any; ok.hidden = any; }
    const setDot = (key: string, attention: boolean) => {
      const dot = document.querySelector<HTMLElement>(`[data-dot="${key}"]`), text = document.querySelector<HTMLElement>(`[data-dot-text="${key}"]`);
      if (!dot || !editable) return;
      dot.className = `ed-dot ${attention ? 'warn' : 'ok'}`; if (text) text.textContent = attention ? 'Needs attention' : 'Done';
    };
    setDot('settings', missing.title || missing.author || missing.section || missing.date);
    setDot('body', missing.body);
  });
  const notice = new URLSearchParams(location.search).get('n');
  setPanel(location.hash.slice(1) || (['photos', 'uploaded', 'photo_moved', 'photos_markers', 'photo_replaced', 'photo_unchanged'].includes(notice ?? '') ? 'photos' : notice === 'published' ? 'review' : 'content'));
  render();
}
