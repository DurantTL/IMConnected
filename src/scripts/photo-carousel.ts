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
    root.append(bar);

    let index = 0;
    let lockUntil = 0; // while a button- or key-driven scroll is animating, scroll events must not move the counter back
    const render = () => {
      count.textContent = `${index + 1} of ${total}`;
      prev.disabled = index === 0;
      next.disabled = index === total - 1;
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
    const go = (i: number) => {
      index = Math.max(0, Math.min(total - 1, i));
      lockUntil = Date.now() + 700;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      track.scrollTo({ left: offset(slides[index]), behavior: reduce ? 'auto' : 'smooth' });
      render();
    };
    render();
    prev.addEventListener('click', () => go(index - 1));
    next.addEventListener('click', () => go(index + 1));
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
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
