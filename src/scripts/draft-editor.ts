// Behaviour for /admin/drafts/<id>: toolbar, server-side preview, autosave, conflict handling.
// Everything the server renders works without it except the toolbar, the preview and autosave.
import './story-builder';
import './editor-shell';

const form = document.getElementById('draft-form') as HTMLFormElement | null;

// Show times in the viewer's own time zone (also used by the inbox and published lists).
for (const t of document.querySelectorAll<HTMLTimeElement>('time[data-local]')) {
  const d = new Date(t.dateTime);
  if (!Number.isNaN(d.getTime())) t.textContent = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

if (form) {
  const body = document.getElementById('f-body') as HTMLTextAreaElement;
  const statusEl = document.getElementById('save-status') as HTMLElement;
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const conflictEl = document.getElementById('conflict') as HTMLElement;
  const preview = document.getElementById('preview') as HTMLIFrameElement;
  const section = document.getElementById('f-section') as HTMLSelectElement;
  const area = document.getElementById('f-area') as HTMLSelectElement;
  const editable = !form.querySelector('fieldset')?.disabled;

  let dirty = false;
  let saving: Promise<boolean> | null = null;
  let conflict = false;

  const setVersion = (v: number | string) => {
    for (const el of document.querySelectorAll<HTMLInputElement>('input[name="version"]')) el.value = String(v);
  };
  const say = (msg: string, bad = false) => {
    statusEl.textContent = msg;
    statusEl.style.color = bad ? '#8a1f11' : '';
  };

  const revisionChoice = document.getElementById('draft-revision-choice') as HTMLSelectElement | null;
  const revisionRestore = document.getElementById('restore-draft-revision') as HTMLButtonElement | null;
  const revisionStatus = document.getElementById('draft-revision-status');
  let restoringRevision = false;
  async function loadRevisions() {
    if (!revisionChoice || !revisionRestore || !form!.dataset.revisions) return;
    try {
      const selected = revisionChoice.value;
      const response = await fetch(form!.dataset.revisions, { credentials: 'same-origin' }), data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load revision history.');
      revisionChoice.replaceChildren(new Option(data.revisions.length ? 'Choose a previous save' : 'No previous saves yet', ''));
      for (const revision of data.revisions) revisionChoice.append(new Option(`Before save ${new Date(revision.createdAt).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })} CT — ${revision.editor}`, String(revision.id)));
      const historyMeta = document.querySelector('[data-meta="history"]'); if (historyMeta) historyMeta.textContent = `${data.revisions.length} saved ${data.revisions.length === 1 ? 'version' : 'versions'}`;
      revisionChoice.value = selected; revisionRestore.disabled = restoringRevision || !editable || !revisionChoice.value;
    } catch (error) { if (revisionStatus) revisionStatus.textContent = error instanceof Error ? error.message : 'Could not load revision history.'; }
  }
  revisionChoice?.addEventListener('change', () => { if (revisionRestore) revisionRestore.disabled = restoringRevision || !editable || !revisionChoice.value; });
  revisionRestore?.addEventListener('click', async () => {
    const revisionId = revisionChoice?.value;
    if (restoringRevision || !editable || !revisionId || !window.confirm('Save your current edits and restore this previous revision? It will remain a draft.')) return;
    restoringRevision = true;
    revisionRestore.disabled = true;
    const workspace = form!.closest<HTMLElement>('.editor-studio');
    const fields = form!.querySelector('fieldset');
    const wasInert = workspace?.inert ?? false, wasDisabled = fields?.disabled ?? false;
    let navigating = false;
    try {
      if (!(await flushSaves())) return;
      // A restore replaces the form on reload. Prevent edits and photo/module actions
      // after the final save, rather than silently losing input during its request.
      if (workspace) { workspace.inert = true; workspace.setAttribute('aria-busy', 'true'); }
      if (fields) fields.disabled = true;
      const data = new FormData(); data.set('version', String((form!.elements.namedItem('version') as HTMLInputElement).value)); data.set('revisionId', revisionId);
      const response = await fetch(form!.dataset.revisions!, { method: 'POST', credentials: 'same-origin', body: data }), result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not restore this revision.');
      dirty = false; setVersion(result.updatedAt);
      window.location.assign(`${window.location.pathname}?revision_restored=1${result.warnings?.length ? '&missing_media=1' : ''}${result.replacedKept ? '&photo_replaced_kept=1' : ''}#history`);
      navigating = true;
    } catch (error) { if (revisionStatus) revisionStatus.textContent = error instanceof Error ? error.message : 'Could not restore this revision.'; }
    finally {
      if (!navigating) {
        if (workspace) { workspace.inert = wasInert; workspace.removeAttribute('aria-busy'); }
        if (fields) fields.disabled = wasDisabled;
        restoringRevision = false;
        revisionRestore.disabled = !editable || !revisionChoice?.value;
      }
    }
  });
  void loadRevisions();

  // ---- save ----
  async function save(): Promise<boolean> {
    if (!editable || conflict) return !conflict;
    if (saving) return saving;
    if (!dirty) return true;
    saving = (async () => {
      say('Saving…');
      dirty = false;
      try {
        const res = await fetch(form!.dataset.save!, { method: 'POST', body: new FormData(form!), credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          setVersion(data.updatedAt);
          void loadRevisions();
          const t = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          say(`Last saved ${t} by ${data.savedBy}`);
          return true;
        }
        dirty = true;
        if (data.conflict) {
          conflict = true;
          conflictEl.hidden = false;
          conflictEl.scrollIntoView({ block: 'center' });
          say('Not saved. Reload to see the other changes.', true);
        } else {
          say(data.error || 'Could not save. Try again.', true);
        }
        return false;
      } catch {
        dirty = true;
        say('Could not save. Check your connection.', true);
        return false;
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  // A response for an older snapshot does not mean later edits were saved.
  async function flushSaves(): Promise<boolean> {
    if (!editable) return true; // nothing can change, so there is nothing to wait for
    while (dirty || saving) {
      if (!(await save())) return false;
    }
    return !conflict;
  }

  form.addEventListener('input', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-editor-local]')) return;
    dirty = true;
    schedulePreview();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    dirty = true; // an explicit Save always saves
    void flushSaves();
  });
  setInterval(() => {
    if (dirty && !saving && !conflict) void save();
  }, 20000);
  window.addEventListener('beforeunload', (e) => {
    if (dirty && !conflict) e.preventDefault();
  });

  // Photo, publish, reject and restore are ordinary form posts; save pending edits first.
  for (const other of document.querySelectorAll<HTMLFormElement>('#photo-form, #publish-form, #reject-form, #schedule-form, #suggest-form, #unschedule-form')) {
    let resubmitting = false;
    other.addEventListener('submit', (e) => {
      if (resubmitting) return;
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      if (other.id === 'photo-form' && submitter?.value.startsWith('delete:') && !window.confirm('Delete this photo? Any image module using it will also be removed.')) {
        e.preventDefault();
        return;
      }
      if (!dirty && !saving) return;
      e.preventDefault();
      void flushSaves().then((ok) => {
        if (!ok) return;
        resubmitting = true;
        other.requestSubmit(submitter ?? undefined);
      });
    });
  }

  // ---- toolbar ----
  const wrap = (before: string, after: string, placeholder: string) => {
    const { selectionStart: a, selectionEnd: b, value } = body;
    const sel = value.slice(a, b) || placeholder;
    body.setRangeText(before + sel + after, a, b, 'end');
    body.setSelectionRange(a + before.length, a + before.length + sel.length);
  };
  const prefixLines = (prefix: string) => {
    const { selectionStart: a, selectionEnd: b, value } = body;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const chunk = value.slice(start, b) || 'text';
    body.setRangeText(chunk.split('\n').map((l) => prefix + l).join('\n'), start, b, 'end');
  };
  const actions: Record<string, () => void> = {
    bold: () => wrap('**', '**', 'bold text'),
    italic: () => wrap('*', '*', 'italic text'),
    heading: () => prefixLines('## '),
    quote: () => prefixLines('> '),
    list: () => prefixLines('- '),
    link: () => {
      const url = window.prompt('Link address (https://…)', 'https://');
      if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) wrap('[', `](${url.trim()})`, 'link text');
    },
  };
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-md]')) {
    btn.addEventListener('click', () => {
      body.focus();
      actions[btn.dataset.md!]?.();
      dirty = true;
      schedulePreview();
    });
  }

  // ---- preview (rendered on the server; shown in a sandboxed frame that cannot run scripts) ----
  let previewTimer: number | undefined;
  let previewSeq = 0;
  async function renderPreview() {
    const seq = ++previewSeq;
    try {
      const res = await fetch(form!.dataset.preview!, { method: 'POST', body: new FormData(form!), credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (seq === previewSeq && data.ok) preview.srcdoc = data.doc;
    } catch {
      /* the preview is a convenience */
    }
  }
  function schedulePreview() {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, 600);
  }
  void renderPreview();

  // ---- section decides which categories and the column field are offered ----
  function syncSection() {
    for (const checkbox of document.querySelectorAll<HTMLInputElement>('input[name=additionalSections]')) { const primary = checkbox.value === section.value; checkbox.disabled = primary; if (primary) checkbox.checked = true; }
    const hasAreas = Array.from(area.options).some((o) => o.value !== '' && o.dataset.section === section.value);
    for (const opt of Array.from(area.options)) opt.hidden = opt.value === '' ? hasAreas : opt.dataset.section !== section.value;
    if (area.selectedOptions[0]?.hidden) {
      const first = Array.from(area.options).find((o) => !o.hidden);
      if (first) area.value = first.value;
    }
  }
  section.addEventListener('change', syncSection);
  syncSection();
}
