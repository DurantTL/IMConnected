// Click-to-enlarge for story photos (issue #35). No dependency: one native <dialog>, built on first use.
//
// Progressive enhancement: without this script (or without <dialog> support) every photo is still an ordinary link to the
// full image. The script makes the lead photo of an unlaid-out story a link as well, so every photo behaves the same.
// Keyboard: Esc closes, Left/Right move, Home/End jump; focus is kept inside by the modal dialog and goes back to the
// photo that was opened. Touch: swipe left/right. The dialog is labelled with the photo's own alt text.

function init(): void {
  if (typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return;

  // The lead photo of a story without a layout is a bare <img> in a <figure>; give it the same link the others have.
  document.querySelectorAll<HTMLImageElement>('.article > figure > img').forEach((img) => {
    if (img.closest('a') || !img.getAttribute('src')) return;
    const a = document.createElement('a');
    a.href = img.getAttribute('src')!;
    a.setAttribute('data-photo', '');
    if (!img.getAttribute('alt')?.trim()) a.setAttribute('aria-label', 'Enlarge photo'); // a link needs a name
    img.replaceWith(a);
    a.append(img);
  });
  document.querySelectorAll<HTMLAnchorElement>('.gallery a').forEach((a) => a.setAttribute('data-photo', ''));

  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-photo]'));
  if (!links.length) return;
  const total = links.length;

  let dialog: HTMLDialogElement | undefined;
  let stageImg: HTMLImageElement;
  let counter: HTMLElement;
  let prev: HTMLButtonElement;
  let next: HTMLButtonElement;
  let close: HTMLButtonElement;
  let index = 0;
  let opener: HTMLElement | null = null;

  const altOf = (a: HTMLAnchorElement, i: number) => a.querySelector('img')?.getAttribute('alt')?.trim() || `Photo ${i + 1} of ${total}`;

  function show(i: number): void {
    index = (i + total) % total;
    const a = links[index];
    const alt = altOf(a, index);
    stageImg.src = a.href;
    stageImg.alt = alt;
    // The live region announces each photo as it appears: its alt text and the position.
    counter.textContent = total > 1 ? `${alt} (${index + 1} of ${total})` : alt;
    // Warm the neighbours so the next swipe is instant.
    if (total > 1) for (const n of [index + 1, index - 1]) new Image().src = links[(n + total) % total].href;
  }

  function build(): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.className = 'viewer';
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Photo viewer');
    d.innerHTML =
      '<div class="viewer-stage"><img class="viewer-img" alt="" decoding="async"></div>' +
      '<button type="button" class="viewer-btn viewer-close" aria-label="Close photo viewer"><span aria-hidden="true">&times;</span></button>' +
      (total > 1
        ? '<button type="button" class="viewer-btn viewer-prev" aria-label="Previous photo"><span aria-hidden="true">&#8249;</span></button>' +
          '<button type="button" class="viewer-btn viewer-next" aria-label="Next photo"><span aria-hidden="true">&#8250;</span></button>'
        : '') +
      '<p class="viewer-count" aria-live="polite"></p>';
    document.body.append(d);
    stageImg = d.querySelector('.viewer-img')!;
    counter = d.querySelector('.viewer-count')!;
    close = d.querySelector('.viewer-close')!;
    prev = d.querySelector('.viewer-prev')!;
    next = d.querySelector('.viewer-next')!;
    close.addEventListener('click', () => d.close());
    prev?.addEventListener('click', () => show(index - 1));
    next?.addEventListener('click', () => show(index + 1));
    // A click on the dark area (not the photo or a button) closes it.
    let swiped = false; // a swipe that ends on the dark area must not also count as a click that closes it
    d.addEventListener('click', (e) => {
      if (swiped) { swiped = false; return; }
      if (e.target === d || (e.target as HTMLElement).classList.contains('viewer-stage')) d.close();
    });
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        // Keep focus on the viewer's own buttons: wrap round instead of leaving the dialog for the browser's chrome.
        const stops = Array.from(d.querySelectorAll<HTMLButtonElement>('button'));
        const at = stops.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at < 0 || at === stops.length - 1 ? 0 : at + 1);
        e.preventDefault();
        stops[to].focus();
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft' && total > 1) { e.preventDefault(); show(index - 1); }
      else if (e.key === 'ArrowRight' && total > 1) { e.preventDefault(); show(index + 1); }
      else if (e.key === 'Home' && total > 1) { e.preventDefault(); show(0); }
      else if (e.key === 'End' && total > 1) { e.preventDefault(); show(total - 1); }
    });
    // Swipe: a mostly horizontal move of at least 50 px.
    let startX = 0;
    let startY = 0;
    let tracking = false;
    d.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('button')) return;
      tracking = true; startX = e.clientX; startY = e.clientY;
    });
    d.addEventListener('pointerup', (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) >= 10 || Math.abs(dy) >= 10) { swiped = true; setTimeout(() => { swiped = false; }, 400); }
      if (total > 1 && Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) show(dx < 0 ? index + 1 : index - 1);
    });
    d.addEventListener('pointercancel', () => { tracking = false; });
    d.addEventListener('close', () => {
      document.documentElement.classList.remove('viewer-open');
      stageImg.removeAttribute('src');
      (opener && opener.isConnected ? opener : null)?.focus();
      opener = null;
    });
    return d;
  }

  function open(i: number, from: HTMLElement): void {
    dialog ??= build();
    opener = from;
    show(i);
    document.documentElement.classList.add('viewer-open');
    if (!dialog.open) dialog.showModal();
    close.focus();
  }

  links.forEach((a, i) => {
    a.addEventListener('click', (e) => {
      // Let "open in a new tab" and friends do what the browser does.
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      open(i, a);
    });
  });
}

init();
