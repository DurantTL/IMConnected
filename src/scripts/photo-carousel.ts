// Carousel buttons and counter for the "carousel" photo layout (issue #85). Progressive enhancement: without this script the
// carousel is a horizontally scrollable, scroll-snap strip with a visible scrollbar and every photo is a link to its full image.
// Never autoplays. The "3 of 7" counter is a polite live region whose text only changes when the reader moves (button, arrow
// key, swipe or scroll), so nothing is announced on load. Smooth scrolling is skipped for reduced motion (CSS covers the strip).

function init(): void {
  document.querySelectorAll<HTMLElement>('[data-carousel]').forEach((root) => {
    const track = root.querySelector<HTMLElement>('[data-carousel-track]');
    const slides = Array.from(root.querySelectorAll<HTMLElement>('[data-carousel-slide]'));
    if (!track || slides.length < 2) return;
    const total = slides.length;
    root.classList.add('is-enhanced');

    const bar = document.createElement('div');
    bar.className = 'photos-carousel-bar';
    const mk = (label: string, glyph: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      const g = document.createElement('span');
      g.setAttribute('aria-hidden', 'true');
      g.textContent = glyph;
      b.append(g);
      return b;
    };
    const prev = mk('Previous photo', '‹');
    const next = mk('Next photo', '›');
    const count = document.createElement('p');
    count.className = 'photos-carousel-count';
    count.setAttribute('aria-live', 'polite');
    count.setAttribute('aria-atomic', 'true');
    bar.append(prev, count, next);

    let index = 0;
    let lockUntil = 0; // while a button- or key-driven scroll is animating, scroll events must not move the counter back
    // aria-disabled (not disabled) keeps a focused button focusable when the reader reaches either end.
    const render = () => {
      count.textContent = `${index + 1} of ${total}`;
      prev.setAttribute('aria-disabled', String(index === 0));
      next.setAttribute('aria-disabled', String(index === total - 1));
    };
    const offset = (s: HTMLElement) => s.offsetLeft - track.offsetLeft;
    const nearest = () => {
      let best = 0;
      let dist = Infinity;
      slides.forEach((s, i) => {
        const d = Math.abs(offset(s) - track.scrollLeft);
        if (d < dist) { dist = d; best = i; }
      });
      return best;
    };
    let settle: ReturnType<typeof setTimeout> | undefined;
    const go = (i: number, focusSlide = false) => {
      index = Math.max(0, Math.min(total - 1, i));
      lockUntil = Date.now() + 700;
      clearTimeout(settle);
      settle = setTimeout(() => { const n = nearest(); if (n !== index) { index = n; render(); } }, 720); // never leave the counter stale after the lock ends
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      track.scrollTo({ left: offset(slides[index]), behavior: reduce ? 'auto' : 'smooth' });
      render();
      if (focusSlide) slides[index].querySelector<HTMLElement>('a')?.focus({ preventScroll: true }); // focus follows the photo that scrolled into view
    };
    render(); // before the bar is in the page, so nothing is announced on load
    root.append(bar);
    prev.addEventListener('click', () => { if (index > 0) go(index - 1); });
    next.addEventListener('click', () => { if (index < total - 1) go(index + 1); });
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1, true); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1, true); }
    });
    let t: ReturnType<typeof setTimeout> | undefined;
    track.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (Date.now() < lockUntil) return;
        const i = nearest();
        if (i !== index) { index = i; render(); }
      }, 80);
    }, { passive: true });
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
