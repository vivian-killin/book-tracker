/**
 * Butterflies and glitter that follow the pointer.
 *
 * This was a theme module with three looks and a picker. There is one look
 * now, and it lives entirely in assets/theme.css — so all that is left here is
 * the decoration, which needs script.
 *
 * It is off for anyone who has asked for reduced motion. A particle trail
 * chasing the cursor is exactly what that setting exists to prevent, so it
 * stops completely rather than slowing down.
 */

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/*
 * Touch screens have no cursor to follow. They do fire a synthetic mousemove
 * on tap, though, which left the butterflies frozen mid-page — so they are
 * skipped outright rather than relying on the event never arriving.
 */
const HOVERS = window.matchMedia('(hover: hover)').matches;
const WINGS = ['#ff8ec9', '#ffd166', '#c084fc'];

let layer = null;
let flock = [];
let last = 0;
let seq = 0;

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
         <ellipse cx="9" cy="10" rx="8.4" ry="9.4" fill="${WINGS[i % 3]}" opacity="0.92"/>
         <ellipse cx="23" cy="10" rx="8.4" ry="9.4" fill="${WINGS[i % 3]}" opacity="0.92"/>
         <ellipse cx="10" cy="19" rx="5.6" ry="6.2" fill="${WINGS[(i + 1) % 3]}" opacity="0.85"/>
         <ellipse cx="22" cy="19" rx="5.6" ry="6.2" fill="${WINGS[(i + 1) % 3]}" opacity="0.85"/>
       </g>
       <rect x="15" y="6" width="2" height="17" rx="1" fill="#7c3aed"/>`;
    layer.appendChild(el);
    return el;
  });
}

function onMove(e) {
  if (reduced.matches || !HOVERS) return;
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

function teardown() {
  if (!layer) return;
  layer.remove();
  layer = null;
  flock = [];
}

/** Start the cursor decoration. Safe to call on a page that never sees a mouse. */
export function init() {
  if (!HOVERS) return;
  window.addEventListener('mousemove', onMove, { passive: true });
  reduced.addEventListener('change', () => {
    if (reduced.matches) teardown();
  });
}
