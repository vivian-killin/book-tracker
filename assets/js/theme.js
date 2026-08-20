/**
 * Theme switching, and the decoration that rides on one of them.
 *
 * Themes are a `data-theme` attribute on <html> and a stored choice. All the
 * visual difference lives in assets/theme.css — nothing here knows what a
 * theme looks like, only which one is on.
 */

const KEY = 'book-tracker:theme';
export const THEMES = [
  { id: 'barbie', label: 'Barbie' },
  { id: 'warm', label: 'Warm' },
  { id: 'night', label: 'Night' },
];
const DEFAULT = 'barbie';

/** @returns {string} the stored theme, or the default */
export function current() {
  const stored = localStorage.getItem(KEY);
  return THEMES.some((t) => t.id === stored) ? stored : DEFAULT;
}

/**
 * Apply a theme and remember it.
 * @param {string} id
 * @param {() => void} [onChange] redraw hook — charts read their colours from
 *   CSS custom properties at draw time, so they need to be told to redraw.
 */
export function apply(id, onChange) {
  const theme = THEMES.some((t) => t.id === id) ? id : DEFAULT;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(KEY, theme);
  sparkle.setEnabled(theme === 'barbie');
  if (onChange) onChange();
}

/** Set the theme on load, before anything measures colours. */
export function init() {
  document.documentElement.setAttribute('data-theme', current());
  sparkle.setEnabled(current() === 'barbie');
}

/**
 * Render the theme picker into a container.
 * @param {HTMLElement} host
 * @param {() => void} [onChange]
 */
export function renderPicker(host, onChange) {
  host.textContent = '';
  for (const t of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.textContent = t.label;
    btn.setAttribute('aria-pressed', String(current() === t.id));
    btn.addEventListener('click', () => {
      apply(t.id, onChange);
      renderPicker(host, onChange);
    });
    host.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// Cursor butterflies and glitter — Barbie only
// ---------------------------------------------------------------------------

/**
 * Trailing butterflies and sparkles that follow the pointer.
 *
 * Off unless the Barbie theme is on, and off entirely for anyone who has asked
 * for reduced motion — a particle trail that follows the cursor is exactly the
 * kind of thing that setting exists to stop.
 */
const sparkle = (() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let layer = null;
  let enabled = false;
  let last = 0;
  let seq = 0;
  const wings = ['#ff8ec9', '#ffd166', '#c084fc'];
  let flock = [];

  function build() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'sparkle-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);

    flock = [0, 1, 2].map((i) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('viewBox', '0 0 32 26');
      el.setAttribute('class', 'butterfly');
      el.style.width = `${34 - i * 4}px`;
      el.style.height = `${28 - i * 3}px`;
      // Each trails a little further behind, so they read as a flock rather
      // than one sprite glued to the cursor.
      el.style.transition = `transform ${340 + i * 190}ms cubic-bezier(.22,.61,.36,1)`;
      el.innerHTML =
        `<g class="wing">
           <ellipse cx="9" cy="10" rx="8.4" ry="9.4" fill="${wings[i % 3]}" opacity="0.92"/>
           <ellipse cx="23" cy="10" rx="8.4" ry="9.4" fill="${wings[i % 3]}" opacity="0.92"/>
           <ellipse cx="10" cy="19" rx="5.6" ry="6.2" fill="${wings[(i + 1) % 3]}" opacity="0.85"/>
           <ellipse cx="22" cy="19" rx="5.6" ry="6.2" fill="${wings[(i + 1) % 3]}" opacity="0.85"/>
         </g>
         <rect x="15" y="6" width="2" height="17" rx="1" fill="#7c3aed"/>`;
      layer.appendChild(el);
      return el;
    });
  }

  function onMove(e) {
    if (!enabled || reduced.matches) return;
    build();

    flock.forEach((el, i) => {
      el.style.transform =
        `translate(${e.clientX - 16 + (i - 1) * 30}px, ${e.clientY - 34 - i * 14}px)`;
    });

    // One sparkle every 55ms reads as a continuous trail; spawning on every
    // move event would be hundreds of nodes a second.
    const now = performance.now();
    if (now - last < 55) return;
    last = now;
    seq += 1;

    const s = document.createElement('span');
    s.className = 'sparkle';
    const size = 10 + Math.random() * 12;
    s.style.cssText =
      `left:${e.clientX + (Math.random() * 26 - 13)}px;`
      + `top:${e.clientY + (Math.random() * 26 - 13)}px;`
      + `width:${size}px;height:${size}px;`
      + `background:${seq % 3 === 0 ? '#ffd166' : seq % 3 === 1 ? '#ff8ec9' : '#ffffff'};`;
    layer.appendChild(s);
    // The animation is the lifetime; nothing needs a timer of its own.
    s.addEventListener('animationend', () => s.remove());
  }

  function setEnabled(on) {
    enabled = on && !reduced.matches;
    if (!enabled && layer) {
      layer.remove();
      layer = null;
      flock = [];
    }
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  reduced.addEventListener('change', () => setEnabled(enabled));

  return { setEnabled };
})();
