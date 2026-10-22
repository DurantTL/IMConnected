// Inspired by Durant's restrained entrances; content is never hidden waiting for this script.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
if (!reduceMotion.matches && typeof IntersectionObserver === 'function') {
  const animations = new Set<Animation>();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      if (reduceMotion.matches || typeof entry.target.animate !== 'function') continue;
      const animation = entry.target.animate([{ transform: 'translateY(14px)' }, { transform: 'none' }], { duration: 600, easing: 'cubic-bezier(.2,.7,.2,1)' });
      animations.add(animation); animation.finished.then(() => animations.delete(animation)).catch(() => animations.delete(animation));
    }
  }, { threshold: .12 });
  document.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));
  reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) { observer.disconnect(); for (const animation of animations) animation.cancel(); animations.clear(); } });
}
