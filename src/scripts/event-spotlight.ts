// Native scrolling stays available without JavaScript. Rotation never moves keyboard focus.
for (const spotlight of document.querySelectorAll<HTMLElement>('[data-event-spotlight]')) {
  const track = spotlight.querySelector<HTMLElement>('[data-event-track]')!;
  const slides = Array.from(track.querySelectorAll<HTMLElement>('[data-event-slide]'));
  const controls = spotlight.querySelector<HTMLElement>('[data-slider-controls]')!;
  const status = spotlight.querySelector<HTMLElement>('[data-event-status]')!;
  const previous = controls.querySelector<HTMLButtonElement>('[data-slide-step="-1"]')!;
  const next = controls.querySelector<HTMLButtonElement>('[data-slide-step="1"]')!;
  const toggle = spotlight.querySelector<HTMLButtonElement>('[data-slide-play]')!;
  const choices = Array.from(spotlight.querySelectorAll<HTMLButtonElement>('[data-slide-to]'));
  if (slides.length < 2) continue;
  controls.hidden = false;
  spotlight.querySelector<HTMLElement>('[data-slider-navigation]')!.hidden = false;
  spotlight.dataset.enhanced = 'true'; // the native scrollbar stays visible until the arrows and numbers exist
  status.hidden = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let requested = !reduced.matches, hovered = false, focused = false, visible = false, touching = false, userMoved = false, startX = 0, startY = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interval = 7000;
  const active = () => slides.reduce((best, slide, index) =>
    Math.abs(slide.getBoundingClientRect().left - track.getBoundingClientRect().left) <
    Math.abs(slides[best].getBoundingClientRect().left - track.getBoundingClientRect().left) ? index : best, 0);
  const canRotate = () => requested && !reduced.matches && !hovered && !focused && !touching && visible && !document.hidden;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    const rotating = canRotate();
    spotlight.dataset.rotating = String(rotating);
    // Quiet while rotating on its own, but a move the reader just made is announced even if rotation carries on.
    status.setAttribute('aria-live', rotating && !userMoved ? 'off' : 'polite');
    toggle.disabled = reduced.matches;
    // Icon-only: the label carries the state (no aria-pressed), CSS swaps the pause and play icons from data-state.
    toggle.setAttribute('aria-label', reduced.matches ? 'Automatic advance off' : requested ? 'Pause automatic advance' : 'Resume automatic advance');
    toggle.dataset.state = requested && !reduced.matches ? 'playing' : 'paused';
    if (rotating) timer = setTimeout(() => { userMoved = false; go((active() + 1) % slides.length); schedule(); }, interval);
  };
  const update = () => {
    const index = active();
    const text = `Event ${index + 1} of ${slides.length}`;
    if (status.textContent !== text) status.textContent = text;
    choices.forEach((choice, at) => {
      if (index === at) choice.setAttribute('aria-current', 'true');
      else choice.removeAttribute('aria-current');
    });
  };
  const go = (index: number) => track.scrollTo({ left: slides[index].offsetLeft - slides[0].offsetLeft, behavior: reduced.matches ? 'instant' : 'smooth' });
  // Previous and next wrap, like automatic advance, so neither button ever becomes disabled and drops keyboard focus.
  const move = (delta: number) => { userMoved = true; go((active() + delta + slides.length) % slides.length); schedule(); };
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  choices.forEach((choice, index) => choice.addEventListener('click', () => { userMoved = true; go(index); schedule(); }));
  toggle.addEventListener('click', () => { requested = !requested; schedule(); });
  track.addEventListener('keydown', (event) => {
    if (event.target !== track || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1); }
  });
  // Devices without hover (phones) can report a sticky mouse pointer after a touch; it must not hold rotation.
  const canHover = matchMedia('(any-hover: hover)');
  spotlight.addEventListener('pointerenter', (event) => { if (canHover.matches && (event.pointerType === 'mouse' || event.pointerType === 'pen')) { hovered = true; schedule(); } });
  spotlight.addEventListener('pointerleave', () => { hovered = false; schedule(); });
  // Focus on any control except the pause/play toggle holds rotation (a touch or screen-reader activation is not :focus-visible, but the reader is
  // still using it). Only the scrollable track itself needs :focus-visible, so a plain tap on it does not hold rotation.
  // The pause/play toggle never holds rotation: a reader who just chose Resume (Android focuses a tapped button) expects motion.
  spotlight.addEventListener('focusin', (event) => { focused = event.target !== toggle && (event.target !== track || track.matches(':focus-visible')); schedule(); });
  spotlight.addEventListener('focusout', (event) => { if (!(event.relatedTarget instanceof Node && spotlight.contains(event.relatedTarget))) focused = false; schedule(); });
  // A finger pauses rotation only while it is down. The browser cancels the pointer for any pan, vertical page scrolling
  // included, and the track may still be animating a scroll of its own, so a swipe is judged by finger movement: a mostly
  // horizontal drag counts as the reader choosing events themselves and stops automatic advance until Resume is pressed.
  // Browsers that send touch pointers without Touch Events still pause while a finger is down.
  if (!('ontouchstart' in window)) {
    track.addEventListener('pointerdown', (event) => { if (event.pointerType === 'touch') { touching = true; schedule(); } });
    for (const type of ['pointerup', 'pointercancel']) track.addEventListener(type, (event) => { if ((event as PointerEvent).pointerType === 'touch' && touching) { touching = false; schedule(); } });
  }
  track.addEventListener('touchstart', (event) => { touching = true; startX = event.touches[0].clientX; startY = event.touches[0].clientY; schedule(); }, { passive: true });
  track.addEventListener('touchmove', (event) => {
    if (!requested || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX, dy = event.touches[0].clientY - startY;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { requested = false; schedule(); }
  }, { passive: true });
  // Touch events end the gesture even after the pointer was cancelled; another finger may still be down.
  const release = (event: TouchEvent) => { const down = event.touches.length > 0; if (touching === down) return; touching = down; schedule(); };
  track.addEventListener('touchend', release, { passive: true });
  track.addEventListener('touchcancel', release, { passive: true });
  track.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(track);
  document.addEventListener('visibilitychange', schedule);
  reduced.addEventListener('change', () => { if (reduced.matches) { requested = false; track.scrollTo({ left: track.scrollLeft, behavior: 'instant' }); } schedule(); });
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); }, { threshold: .15 }).observe(spotlight);
  } else { visible = true; schedule(); }
  window.addEventListener('pagehide', () => { clear(); spotlight.dataset.rotating = 'false'; });
  window.addEventListener('pageshow', schedule);
  update(); schedule();
}
