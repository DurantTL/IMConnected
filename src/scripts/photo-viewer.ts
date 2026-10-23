// Click-to-enlarge for story photos (issue #35). No dependency: one native <dialog>, built on first use.
//
// Progressive enhancement: without this script (or without <dialog> support) every photo is still an ordinary link to the
// full image. The script makes the lead photo of an unlaid-out story a link as well, so every photo behaves the same.
// Keyboard: Esc closes, Left/Right move, Home/End jump; focus is kept inside by the modal dialog and goes back to the
// photo that was opened. Touch: swipe left/right. The dialog is labelled with the photo's own alt text.
//
// Zoom (issue #83): the photo opens fitted to the screen (100%) and zooms up to 400%. Buttons (Zoom in, Zoom out, Reset), the
// keys + - 0, Ctrl+wheel / trackpad pinch, two-finger touch pinch, and double-click / double-tap (fit <-> 200%). A zoomed photo
// is dragged to pan (while zoomed, the arrow keys pan along an axis the photo overflows, else Left/Right change photo) and is clamped so it can never leave the screen. Showing another photo
// resets the zoom. Only a CSS transform on the already-loaded same-origin image is used. The level is announced politely and
// debounced ("200%"); with reduced motion every change is instant.

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
  let counterAlt: HTMLElement;
  let counterPos: HTMLElement;
  let prev: HTMLButtonElement;
  let next: HTMLButtonElement;
  let close: HTMLButtonElement;
  let zoomIn: HTMLButtonElement;
  let zoomOut: HTMLButtonElement;
  let zoomReset: HTMLButtonElement;
  let zoomLabel: HTMLElement;
  let zoomStatus: HTMLElement;
  let index = 0;
  let opener: HTMLElement | null = null;

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const STEP = 1.5;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  let smoothTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTapToggle = 0;
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // The point the image scales around: the centre of its layout box. Layout offsets ignore the transform (and any transition
  // under way); the dialog is fixed to the viewport, so they are screen coordinates.
  function baseCentre(): { x: number; y: number } {
    return { x: stageImg.offsetLeft + stageImg.offsetWidth / 2, y: stageImg.offsetTop + stageImg.offsetHeight / 2 };
  }

  function clampPan(): void {
    if (scale <= MIN_ZOOM) { tx = 0; ty = 0; return; }
    const vw = dialog!.clientWidth;
    const vh = dialog!.clientHeight;
    const c = baseCentre();
    const w = stageImg.offsetWidth * scale;
    const h = stageImg.offsetHeight * scale;
    // A side larger than the screen may move until its edge meets the screen edge; a smaller side stays centred.
    tx = w <= vw ? 0 : Math.min(w / 2 - c.x, Math.max(vw - c.x - w / 2, tx));
    ty = h <= vh ? 0 : Math.min(h / 2 - c.y, Math.max(vh - c.y - h / 2, ty));
  }

  function render(announce: boolean): void {
    clampPan();
    stageImg.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    stageImg.classList.toggle('zoomed', scale > 1);
    const pct = `${Math.round(scale * 100)}%`;
    zoomLabel.textContent = pct;
    zoomIn.setAttribute('aria-disabled', String(scale >= MAX_ZOOM));
    zoomOut.setAttribute('aria-disabled', String(scale <= MIN_ZOOM));
    zoomReset.setAttribute('aria-disabled', String(scale === 1));
    if (announce) {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => { zoomStatus.textContent = pct; }, 400); // one message after a burst of changes
    }
  }

  // Zoom to `to`, keeping the photo point under (cx, cy) (screen coordinates) where it is.
  function zoomTo(to: number, cx?: number, cy?: number, smooth = false): void {
    to = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, to));
    if (Math.abs(to - scale) < 0.001) return;
    const c = baseCentre();
    const px = (cx ?? c.x) - c.x;
    const py = (cy ?? c.y) - c.y;
    tx = px - ((px - tx) * to) / scale;
    ty = py - ((py - ty) * to) / scale;
    scale = to;
    stageImg.classList.remove('smooth');
    if (smooth && !reduceMotion()) {
      stageImg.classList.add('smooth');
      clearTimeout(smoothTimer);
      smoothTimer = setTimeout(() => stageImg.classList.remove('smooth'), 220);
    }
    render(true);
  }

  function resetZoom(announce = false): void {
    const was = scale;
    scale = 1; tx = 0; ty = 0;
    stageImg.classList.remove('smooth');
    render(announce && was !== 1); // nothing to announce when already at fit
  }

  const altOf = (a: HTMLAnchorElement, i: number) => a.querySelector('img')?.getAttribute('alt')?.trim() || `Photo ${i + 1} of ${total}`;

  function show(i: number): void {
    index = (i + total) % total;
    const a = links[index];
    const alt = altOf(a, index);
    resetZoom();
    zoomStatus.textContent = '';
    clearTimeout(announceTimer);
    stageImg.src = a.href;
    stageImg.alt = alt;
    // The live region announces each photo as it appears: its alt text and the position.
    // Two spans so a long alt text is clamped on screen without hiding the position.
    counterAlt.textContent = alt;
    counterPos.textContent = total > 1 ? ` (${index + 1} of ${total})` : '';
    // Warm the neighbours so the next swipe is instant.
    if (total > 1) for (const n of [index + 1, index - 1]) new Image().src = links[(n + total) % total].href;
  }

  function build(): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.className = 'viewer';
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Photo viewer');
    d.setAttribute('aria-describedby', 'viewer-desc viewer-zoom-hint'); // read on open: the photo's alt text, "n of total" and the zoom keys
    d.innerHTML =
      '<div class="viewer-stage"><img class="viewer-img" alt="" decoding="async" draggable="false"></div>' +
      '<button type="button" class="viewer-btn viewer-close" aria-label="Close photo viewer"><span aria-hidden="true">&times;</span></button>' +
      '<div class="viewer-zoom" role="group" aria-label="Zoom">' +
      '<button type="button" class="viewer-btn viewer-zoom-out" aria-label="Zoom out" aria-disabled="true"><span aria-hidden="true">&minus;</span></button>' +
      '<button type="button" class="viewer-btn viewer-zoom-in" aria-label="Zoom in"><span aria-hidden="true">+</span></button>' +
      '<button type="button" class="viewer-btn viewer-zoom-reset" aria-label="Reset zoom" aria-disabled="true">Reset</button>' +
      '<span class="viewer-zoom-level" aria-hidden="true">100%</span></div>' +
      '<p class="sr-only" id="viewer-zoom-hint">Plus and minus zoom. While zoomed, arrow keys move the photo where it extends past the screen; 0 resets.</p>' +
      '<p class="sr-only viewer-zoom-status" role="status" aria-live="polite" aria-atomic="true"></p>' +
      (total > 1
        ? '<button type="button" class="viewer-btn viewer-prev" aria-label="Previous photo"><span aria-hidden="true">&#8249;</span></button>' +
          '<button type="button" class="viewer-btn viewer-next" aria-label="Next photo"><span aria-hidden="true">&#8250;</span></button>'
        : '') +
      '<p class="viewer-count" id="viewer-desc" aria-live="polite"><span class="viewer-alt"></span><span class="viewer-pos"></span></p>';
    document.body.append(d);
    stageImg = d.querySelector('.viewer-img')!;
    counterAlt = d.querySelector('.viewer-alt')!;
    counterPos = d.querySelector('.viewer-pos')!;
    close = d.querySelector('.viewer-close')!;
    zoomIn = d.querySelector('.viewer-zoom-in')!;
    zoomOut = d.querySelector('.viewer-zoom-out')!;
    zoomReset = d.querySelector('.viewer-zoom-reset')!;
    zoomLabel = d.querySelector('.viewer-zoom-level')!;
    zoomStatus = d.querySelector('.viewer-zoom-status')!;
    prev = d.querySelector('.viewer-prev')!;
    next = d.querySelector('.viewer-next')!;
    close.addEventListener('click', () => d.close());
    prev?.addEventListener('click', () => show(index - 1));
    next?.addEventListener('click', () => show(index + 1));
    // aria-disabled (not disabled) keeps a pressed button focused when it reaches its limit.
    zoomIn.addEventListener('click', () => zoomTo(scale * STEP, undefined, undefined, true));
    zoomOut.addEventListener('click', () => zoomTo(scale / STEP, undefined, undefined, true));
    zoomReset.addEventListener('click', () => resetZoom(true));
    // Ctrl+wheel (a trackpad pinch arrives as Ctrl+wheel) zooms around the pointer. A plain wheel does nothing.
    d.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Clamped so one notch of a Chrome mouse wheel (100) is a step of about 1.6x, not a jump to the limit.
      const dy = Math.max(-50, Math.min(50, e.deltaY * (e.deltaMode === 1 ? 5 : 1)));
      zoomTo(scale * Math.exp(-dy * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    d.addEventListener('dblclick', (e) => {
      if (Date.now() - lastTapToggle < 600 || e.target !== stageImg) return; // a touch double-tap is handled below
      e.preventDefault();
      zoomTo(scale > 1 ? 1 : 2, e.clientX, e.clientY, true);
    });
    // A click on the dark area (not the photo or a button) closes it.
    let swiped = false; // a swipe or pan that ends on the dark area must not also count as a click that closes it
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
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(scale * STEP, undefined, undefined, true); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomTo(scale / STEP, undefined, undefined, true); return; }
      if (e.key === '0') { e.preventDefault(); resetZoom(true); return; }
      const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      // Zoomed: an arrow key pans, a keyboard user's only way to look around, but only along an axis the photo overflows.
      // On an axis it does not overflow Left/Right keep changing photo; Reset (or 0) brings navigation back; the Previous and
      // Next buttons keep working throughout, whichever element has focus.
      const overflows = scale > 1 && (horizontal ? stageImg.offsetWidth * scale - d.clientWidth > 8 : stageImg.offsetHeight * scale - d.clientHeight > 8);
      if (overflows && e.key.startsWith('Arrow')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') tx += 80; else if (e.key === 'ArrowRight') tx -= 80; else if (e.key === 'ArrowUp') ty += 80; else ty -= 80;
        render(false);
        return;
      }
      if (e.key === 'ArrowLeft' && total > 1) { e.preventDefault(); show(index - 1); }
      else if (e.key === 'ArrowRight' && total > 1) { e.preventDefault(); show(index + 1); }
      else if (e.key === 'Home' && total > 1) { e.preventDefault(); show(0); }
      else if (e.key === 'End' && total > 1) { e.preventDefault(); show(total - 1); }
    });

    // Pointers: one finger or the mouse swipes (fit) or pans (zoomed); two fingers pinch.
    const pts = new Map<number, { x: number; y: number }>();
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let tracking = false;
    let moved = false;
    let pinched = false;
    let wasPinch = false;
    let pinchDist = 0;
    let downOnImg = false;
    let lastTap = { t: 0, x: 0, y: 0 };
    const dist = () => { const [a, b] = Array.from(pts.values()); return Math.hypot(a.x - b.x, a.y - b.y); };
    const mid = () => { const [a, b] = Array.from(pts.values()); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    d.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      swiped = false; // a new gesture: never let an earlier drag swallow this one's click
      if (e.pointerType === 'mouse' && (scale === 1 || e.button !== 0)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) { tracking = true; moved = false; pinched = false; wasPinch = false; startX = lastX = e.clientX; startY = lastY = e.clientY; }
      else if (pts.size === 2) { pinched = true; pinchDist = dist() || 1; }
      if (pts.size === 1) downOnImg = e.target === stageImg; // no explicit pointer capture: it would retarget the click that follows
    });
    d.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      if (e.pointerType === 'mouse' && e.buttons === 0) { end(e, true); return; } // the button was released outside the window
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const nd = dist();
        const m = mid();
        zoomTo(scale * (nd / pinchDist), m.x, m.y);
        pinchDist = nd || 1;
        moved = true;
      } else if (tracking && scale > 1 && !pinched) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > 4) moved = true;
        tx += e.clientX - lastX; ty += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        render(false);
      }
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size === 1) { // one finger of a pinch lifted: carry on panning with the other without a jump
        const [p] = Array.from(pts.values());
        lastX = startX = p.x; lastY = startY = p.y;
        pinched = false; wasPinch = true;
        return;
      }
      if (pts.size > 0 || !tracking) return;
      tracking = false;
      if (moved && e.pointerType === 'mouse' && (wasPinch || pinched || scale > 1)) { swiped = true; setTimeout(() => { swiped = false; }, 400); }
      if (cancelled || pinched || wasPinch) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (scale === 1 && Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        // Swipe: a mostly horizontal move of at least 50 px. Only a real swipe swallows the click the browser sends after it;
        // a tap that drifted a little still closes.
        swiped = true;
        setTimeout(() => { swiped = false; }, 400);
        if (total > 1) show(dx < 0 ? index + 1 : index - 1);
        return;
      }
      // Double-tap on the photo (touch or pen): toggle fit and 2x around the tap.
      if (e.pointerType !== 'mouse' && Math.hypot(dx, dy) < 10 && downOnImg) {
        const now = Date.now();
        if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          lastTapToggle = now;
          lastTap = { t: 0, x: 0, y: 0 };
          zoomTo(scale > 1 ? 1 : 2, e.clientX, e.clientY, true);
        } else lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    };
    d.addEventListener('pointerup', (e) => end(e, false));
    d.addEventListener('pointercancel', (e) => end(e, true));
    // Safari's own pinch gesture on the photo would zoom the page instead of the photo.
    for (const type of ['gesturestart', 'gesturechange']) stageImg.addEventListener(type, (e) => e.preventDefault());
    window.addEventListener('resize', () => { if (d.open) render(false); });
    d.addEventListener('close', () => {
      document.documentElement.classList.remove('viewer-open');
      stageImg.removeAttribute('src');
      resetZoom();
      zoomStatus.textContent = '';
      clearTimeout(announceTimer);
      pts.clear();
      tracking = false;
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
