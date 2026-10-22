for (const spotlight of document.querySelectorAll<HTMLElement>('[data-event-spotlight]')) {
  const track = spotlight.querySelector<HTMLElement>('[data-event-track]')!, slides = Array.from(track.querySelectorAll<HTMLElement>('[data-event-slide]'));
  const controls = spotlight.querySelector<HTMLElement>('[data-slider-controls]')!, status = spotlight.querySelector<HTMLElement>('[data-event-status]')!;
  const previous = controls.querySelector<HTMLButtonElement>('[data-slide-step="-1"]')!, next = controls.querySelector<HTMLButtonElement>('[data-slide-step="1"]')!;
  if (slides.length < 2) continue;
  controls.hidden = false; status.hidden = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const active = () => slides.reduce((best, slide, i) => Math.abs(slide.getBoundingClientRect().left - track.getBoundingClientRect().left) < Math.abs(slides[best].getBoundingClientRect().left - track.getBoundingClientRect().left) ? i : best, 0);
  const update = () => { const index = active(); previous.disabled = index === 0; next.disabled = index === slides.length - 1; const text = `Event ${index + 1} of ${slides.length}`; if (status.textContent !== text) status.textContent = text; };
  const move = (delta: number) => { const index = Math.max(0, Math.min(slides.length - 1, active() + delta)); track.scrollTo({ left: slides[index].offsetLeft - slides[0].offsetLeft, behavior: reduced.matches ? 'instant' : 'smooth' }); };
  previous.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1));
  track.addEventListener('keydown', (e) => { if (e.target !== track || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1); } });
  track.addEventListener('scroll', update, { passive: true }); new ResizeObserver(update).observe(track); update();
}
