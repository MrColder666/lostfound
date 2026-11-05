// Lightweight CSS 3D enhancement. No WebGL, dependencies or layout animation.
const FINE_POINTER = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const REDUCED = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function initScrollProgress() {
  if (document.querySelector('.scroll-progress')) return;
  const bar = document.createElement('div');
  bar.className = 'scroll-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);
  let queued = false;
  const paint = () => {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, window.scrollY / max));
    bar.style.transform = `scaleX(${progress})`;
    queued = false;
  };
  window.addEventListener('scroll', () => {
    if (!queued) { queued = true; requestAnimationFrame(paint); }
  }, { passive: true });
  window.addEventListener('resize', paint, { passive: true });
  paint();
}

function tiltLocker(root) {
  const scene = root.querySelector('.rack-scene');
  const rack = root.querySelector('.rack');
  if (!scene || !rack || scene.dataset.tiltWired || REDUCED() || !FINE_POINTER()) return;
  scene.dataset.tiltWired = '1';
  let frame = 0;
  let next = null;
  const render = () => {
    if (!next) return;
    rack.style.setProperty('--rack-x', `${next.x}deg`);
    rack.style.setProperty('--rack-y', `${next.y}deg`);
    frame = 0;
  };
  scene.addEventListener('pointermove', (event) => {
    const r = scene.getBoundingClientRect();
    const px = (event.clientX - r.left) / r.width - 0.5;
    const py = (event.clientY - r.top) / r.height - 0.5;
    next = { x: -4 - py * 9, y: -9 + px * 15 };
    if (!frame) frame = requestAnimationFrame(render);
  });
  scene.addEventListener('pointerleave', () => {
    next = { x: -4, y: -9 };
    if (!frame) frame = requestAnimationFrame(render);
  });
}

function tiltCards(root) {
  if (REDUCED() || !FINE_POINTER()) return;
  root.querySelectorAll('.item-card').forEach((card) => {
    if (card.dataset.tiltWired) return;
    card.dataset.tiltWired = '1';
    let frame = 0;
    let next = null;
    const render = () => {
      if (!next) return;
      card.style.setProperty('--card-x', `${next.x}deg`);
      card.style.setProperty('--card-y', `${next.y}deg`);
      frame = 0;
    };
    card.addEventListener('pointermove', (event) => {
      const r = card.getBoundingClientRect();
      next = {
        x: ((event.clientY - r.top) / r.height - 0.5) * -2.4,
        y: ((event.clientX - r.left) / r.width - 0.5) * 2.4,
      };
      if (!frame) frame = requestAnimationFrame(render);
    });
    card.addEventListener('pointerleave', () => {
      next = { x: 0, y: 0 };
      if (!frame) frame = requestAnimationFrame(render);
    });
  });
}

export function initExperience(root) {
  initScrollProgress();
  tiltLocker(root);
  tiltCards(root);
}
