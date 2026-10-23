// Drag to reorder photos (issue 87). Pointer events, so mouse, pen and touch all work, but only from the "Drag" handle:
// dragging anywhere else would fight the pan/zoom crop controls and page scrolling on touch. The Up/Down buttons stay
// the keyboard and screen-reader path and the no-JavaScript path. A drop submits the ordinary photo form
// (version-checked, saves pending edits first) with op=move:<id> and the new 1-based position. Escape or a lost pointer cancels.
const list = document.querySelector<HTMLOListElement>('ol.ed-photos');
const form = document.querySelector<HTMLFormElement>('#photo-form');
const live = document.querySelector<HTMLElement>('#photo-reorder-live');

// Only the file for the action being taken is sent: choosing a file in another photo's Replace or in Upload must not ride along.
form?.addEventListener('formdata', (e) => {
  const op = String(e.formData.get('op') ?? '');
  for (const key of [...new Set([...e.formData.keys()])]) {
    if (key === 'photos' ? op !== 'upload' : key.startsWith('replacement_') && op !== `replace:${key.slice('replacement_'.length)}`) e.formData.delete(key);
  }
});

if (list && form) {
  const items = () => [...list.querySelectorAll<HTMLLIElement>(':scope > li[data-photo-item]')];
  for (const handle of list.querySelectorAll<HTMLElement>('[data-photo-handle]')) {
    handle.hidden = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const li = handle.closest<HTMLLIElement>('li[data-photo-item]')!;
      const from = items().indexOf(li);
      let target = from;
      let finished = false;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      li.classList.add('is-dragging');
      const clear = () => items().forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      const move = (ev: PointerEvent) => {
        const all = items();
        // The photo card the pointer is over (or the nearest one) is where the dragged photo lands.
        let t = 0, best = Infinity;
        for (let i = 0; i < all.length; i++) {
          const r = all[i].getBoundingClientRect();
          const distance = ev.clientY < r.top ? r.top - ev.clientY : ev.clientY > r.bottom ? ev.clientY - r.bottom : 0;
          if (distance < best) { best = distance; t = i; }
        }
        target = t;
        clear();
        if (target !== from) all[target].classList.add(target < from ? 'drop-before' : 'drop-after');
      };
      const end = (cancel: boolean) => {
        if (finished) return;
        finished = true;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', cancelled);
        handle.removeEventListener('lostpointercapture', cancelled);
        document.removeEventListener('keydown', key, true);
        li.classList.remove('is-dragging');
        clear();
        if (cancel || target === from) return;
        for (const [name, value] of [['op', `move:${li.dataset.photoItem}`], ['to', String(target + 1)]]) {
          form.querySelector(`input[type=hidden][data-reorder="${name}"]`)?.remove();
          const input = document.createElement('input');
          input.type = 'hidden'; input.name = name; input.value = value; input.dataset.reorder = name;
          form.append(input);
        }
        form.requestSubmit();
      };
      const up = () => end(false);
      const cancelled = () => end(true);
      const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); end(true); } };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', cancelled);
      handle.addEventListener('lostpointercapture', cancelled);
      document.addEventListener('keydown', key, true);
    });
  }
}

// After a move or replace the page reloads: reopen the Photos tab, put focus on the control for the photo that was acted on,
// and speak the result. The live region is empty at load and filled a moment later, because text already present is not announced.
{
  const params = new URLSearchParams(location.search);
  const photo = params.get('photo');
  const n = params.get('n') ?? '';
  if (photo && /^\d{1,12}$/.test(photo) && live?.dataset.announce) {
    const message = live.dataset.announce;
    setTimeout(() => {
      document.querySelector<HTMLButtonElement>('[data-studio-tab="photos"]')?.click();
      const item = document.querySelector<HTMLElement>(`li[data-photo-item="${photo}"]`);
      const target = n === 'photo_replaced'
        ? item?.querySelector<HTMLElement>('.ph-replace summary')
        : item?.querySelector<HTMLElement>('button[value^="up:"]:not(:disabled), button[value^="down:"]:not(:disabled)');
      target?.focus({ preventScroll: false });
      setTimeout(() => { live.textContent = message; }, 250);
    }, 0);
  }
}
