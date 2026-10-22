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
    const marker = `\n\n{{photo ${choice.value}}}\n\n`;
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
  const writePane = split.querySelector<HTMLElement>('.ed-write')!;
  const previewPane = split.querySelector<HTMLElement>('.ed-preview')!;
  const inspector = document.getElementById('module-inspector')!;
  const compact = window.matchMedia('(max-width: 1100px)');
  const library = document.querySelector<HTMLDetailsElement>('.sb-library-disclosure')!;
  const phone = window.matchMedia('(max-width: 650px)');
  if (phone.matches) library.open = false;
  phone.addEventListener('change', () => { library.open = !phone.matches; });
  const editable = !form.querySelector('fieldset')?.disabled;
  type Photo = { id: number; src: string; alt: string; focalX: number; focalY: number; zoom: number };
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
    const writeTab = document.querySelector('[data-view=write]');
    if (writeTab) writeTab.textContent = modular ? 'Build' : 'Write';
    workspace.hidden = !modular;
    markdown.hidden = modular;
    syncPanes();
    highlightCanvas();
    useModules.setAttribute('aria-pressed', String(modular));
    useMarkdown.setAttribute('aria-pressed', String(!modular));
    useModules.textContent = modular ? 'Modules active' : 'Use modules';
    useMarkdown.textContent = modular ? 'Switch to Markdown' : 'Markdown active';
    undo.disabled = !editable || !history.length;
    redo.disabled = !editable || !future.length;
    const count = document.getElementById('module-count');
    if (count) count.textContent = String(countStoryBlocks(blocks));
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
      const select = button(`${display}. ${labels[block.type]}${column !== undefined ? ` · Column ${column + 1}` : ''}`, () => { selected = block.id; render(); focusSelected(); });
      select.dataset.selectModule = block.id;
      const grip = node('span', '⠿', 'sb-grip'); grip.setAttribute('aria-hidden', 'true'); select.prepend(grip);
      select.setAttribute('aria-pressed', String(selected === block.id));
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
      fields.append(node('p', 'Readers press Play to load the provider. Private preview shows a safe provider link.', 'admin-note'));
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
    const previewOnly = compact.matches && split.dataset.view === 'preview';
    for (const [pane, visible] of [[writePane, !previewOnly], [previewPane, !compact.matches || previewOnly], [inspector, modular && !previewOnly]] as const) {
      pane.hidden = !visible;
      pane.inert = !visible;
    }
  }
  compact.addEventListener('change', syncPanes);
  new MutationObserver(syncPanes).observe(split, { attributes: true, attributeFilter: ['data-view'] });
  const librarySearch = document.getElementById('module-library-search') as HTMLInputElement;
  const libraryReset = document.getElementById('module-library-reset') as HTMLButtonElement;
  function filterLibrary() {
    const query = librarySearch.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const add of document.querySelectorAll<HTMLButtonElement>('[data-add-module]')) {
      const matchesQuery = `${add.textContent} ${add.dataset.addModule}`.toLocaleLowerCase().includes(query);
      add.hidden = !matchesQuery;
      if (matchesQuery) matches++;
    }
    document.getElementById('module-library-results')!.textContent = `${matches} ${matches === 1 ? 'module' : 'modules'}${query ? ' found' : ''}`;
    document.getElementById('module-library-empty')!.hidden = matches > 0;
    libraryReset.hidden = !librarySearch.value;
  }
  librarySearch.addEventListener('input', (event) => { event.stopPropagation(); filterLibrary(); });
  libraryReset.addEventListener('click', () => { librarySearch.value = ''; filterLibrary(); librarySearch.focus(); });
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
    const selectFromCanvas = (target: Element) => {
      if (!editable || !modular) return;
      const id = target.closest<HTMLElement>('[data-module-id]')?.dataset.moduleId;
      if (!id || !walkStoryBlocks(blocks).some((block) => block.id === id)) return;
      selected = id;
      // On phones, selecting a canvas module opens the Build view before focusing its field.
      split.dataset.view = 'write';
      for (const tab of document.querySelectorAll<HTMLElement>('.ed-tabs [data-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.view === 'write'));
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
    if (!editable) return;
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
    if (!photo || !input) return;
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
  for (const surface of document.querySelectorAll<HTMLElement>('[data-pan-photo]')) {
    const photo = photos.find((p) => p.id === Number(surface.dataset.panPhoto));
    const image = surface.querySelector('img')!;
    if (!photo) continue;
    let start: { x: number; y: number; focalX: number; focalY: number; overflowX: number; overflowY: number } | undefined;
    surface.addEventListener('pointerdown', (event) => {
      if (!editable || event.button !== 0 || !image.naturalWidth || !image.naturalHeight) return;
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
  function setPanel(name: string, focus = false) {
    if (!panels.some((panel) => panel.dataset.studioPanel === name)) name = 'content';
    for (const panel of panels) {
      const active = panel.dataset.studioPanel === name;
      panel.hidden = !active; panel.inert = !active;
    }
    for (const tab of tabs) {
      const active = tab.dataset.studioTab === name;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    }
    document.querySelector('.editor-studio')?.setAttribute('data-active-panel', name);
    if (focus) tabs.find((tab) => tab.dataset.studioTab === name)?.focus();
    if (window.location.hash !== `#${name}`) window.history.replaceState(null, '', `#${name}`);
  }
  const tabbar = document.querySelector<HTMLElement>('.studio-tabs');
  if (tabbar) tabbar.hidden = false;
  for (const tab of tabs) {
    tab.addEventListener('click', () => setPanel(tab.dataset.studioTab!, true));
    tab.addEventListener('keydown', (event) => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault(); setPanel(tabs[index].dataset.studioTab!, true);
    });
  }
  for (const control of document.querySelectorAll<HTMLElement>('[data-open-panel]')) control.addEventListener('click', () => setPanel(control.dataset.openPanel!, true));
  const saveStatus = document.getElementById('save-status');
  const mobileSaveStatus = document.querySelector('[data-mobile-save-status]');
  if (saveStatus && mobileSaveStatus) {
    const reflectStatus = () => { mobileSaveStatus.textContent = saveStatus.textContent; };
    reflectStatus();
    new MutationObserver(reflectStatus).observe(saveStatus, { childList: true, subtree: true, characterData: true });
  }
  for (const control of document.querySelectorAll('[data-studio-preview]')) control.addEventListener('click', () => {
    setPanel('content');
    document.getElementById('split')!.dataset.view = 'preview';
    for (const tab of document.querySelectorAll('.ed-tabs [data-view]')) tab.setAttribute('aria-pressed', String((tab as HTMLElement).dataset.view === 'preview'));
    previewFrame.focus();
  });
  form.addEventListener('input', () => {
    const storyTitle = (form.elements.namedItem('title') as HTMLInputElement)?.value.trim() || 'Untitled story';
    const author = (form.elements.namedItem('author') as HTMLInputElement)?.value.trim() || 'Add an author in Story settings';
    const heading = document.querySelector('.studio-title-line h1'); if (heading) heading.textContent = storyTitle;
    const reviewTitle = document.querySelector('[data-review-title]'); if (reviewTitle) reviewTitle.textContent = storyTitle;
    const reviewAuthor = document.querySelector('[data-review-author]'); if (reviewAuthor) reviewAuthor.textContent = author;
  });
  const notice = new URLSearchParams(location.search).get('n');
  setPanel(location.hash.slice(1) || (notice === 'photos' || notice === 'uploaded' ? 'photos' : notice === 'published' ? 'review' : 'content'));
  render();
}
