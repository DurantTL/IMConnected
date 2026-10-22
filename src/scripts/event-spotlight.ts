// Native scrolling stays available without JavaScript. Rotation never moves keyboard focus.
for (const spotlight of document.querySelectorAll<HTMLElement>('[data-event-spotlight]')) {
  const track = spotlight.querySelector<HTMLElement>('[data-event-track]')!;
  const slides = Array.from(track.querySelectorAll<HTMLElement>('[data-event-slide]'));
  const controls = spotlight.querySelector<HTMLElement>('[data-slider-controls]')!;
  const status = spotlight.querySelector<HTMLElement>('[data-event-status]')!;
  const previous = controls.querySelector<HTMLButtonElement>('[data-slide-step="-1"]')!;
  const next = controls.querySelector<HTMLButtonElement>('[data-slide-step="1"]')!;
  const toggle = spotlight.querySelector<HTMLButtonElement>('[data-slide-play]')!;
  const rotation = spotlight.querySelector<HTMLElement>('[data-rotation-state]')!;
  const choices = Array.from(spotlight.querySelectorAll<HTMLButtonElement>('[data-slide-to]'));
  if (slides.length < 2) continue;
  controls.hidden = false;
  spotlight.querySelector<HTMLElement>('[data-slider-navigation]')!.hidden = false;
  status.hidden = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let requested = !reduced.matches, hovered = false, focused = false, visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interval = 7000;
  const active = () => slides.reduce((best, slide, index) =>
    Math.abs(slide.getBoundingClientRect().left - track.getBoundingClientRect().left) <
    Math.abs(slides[best].getBoundingClientRect().left - track.getBoundingClientRect().left) ? index : best, 0);
  const canRotate = () => requested && !reduced.matches && !hovered && !focused && visible && !document.hidden;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    const rotating = canRotate();
    spotlight.dataset.rotating = String(rotating);
    status.setAttribute('aria-live', rotating ? 'off' : 'polite');
    toggle.disabled = reduced.matches;
    toggle.textContent = reduced.matches ? 'Automatic advance off' : requested ? 'Pause auto-advance' : 'Resume auto-advance';
    toggle.setAttribute('aria-pressed', String(requested && !reduced.matches));
    rotation.textContent = reduced.matches ? 'Reduced motion: use the arrows to explore.' : !requested ? 'Automatic advance paused.' : rotating ? 'Next event in 7 seconds.' : 'Paused while you explore.';
    if (rotating) timer = setTimeout(() => { go((active() + 1) % slides.length); schedule(); }, interval);
  };
  const update = () => {
    const index = active();
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    const text = `Event ${index + 1} of ${slides.length}`;
    if (status.textContent !== text) status.textContent = text;
    choices.forEach((choice, at) => {
      if (index === at) choice.setAttribute('aria-current', 'true');
      else choice.removeAttribute('aria-current');
    });
  };
  const go = (index: number) => track.scrollTo({ left: slides[index].offsetLeft - slides[0].offsetLeft, behavior: reduced.matches ? 'instant' : 'smooth' });
  const move = (delta: number) => { go(Math.max(0, Math.min(slides.length - 1, active() + delta))); schedule(); };
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  choices.forEach((choice, index) => choice.addEventListener('click', () => { go(index); schedule(); }));
  toggle.addEventListener('click', () => { requested = !requested; schedule(); });
  track.addEventListener('keydown', (event) => {
    if (event.target !== track || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1); }
  });
  spotlight.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse' || event.pointerType === 'pen') { hovered = true; schedule(); } });
  spotlight.addEventListener('pointerleave', () => { hovered = false; schedule(); });
  spotlight.addEventListener('focusin', () => { focused = true; schedule(); });
  spotlight.addEventListener('focusout', (event) => { focused = event.relatedTarget instanceof Node && spotlight.contains(event.relatedTarget); schedule(); });
  track.addEventListener('pointerdown', () => { requested = false; schedule(); });
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
