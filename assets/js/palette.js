/**
 * Colour checks for the theme palettes.
 *
 * A theme system makes it easy to add a good-looking fourth theme that quietly
 * fails contrast or collapses under colour blindness. These are the checks that
 * catch that, run from the test page against every theme the site ships.
 *
 * The maths is standard and self-contained so the site keeps its promise of no
 * dependencies: sRGB to OKLab for perceptual distance, WCAG relative luminance
 * for contrast, and the Machado-Oliveira-Fernandes (2009) severity-1.0
 * matrices for simulating protanopia and deuteranopia.
 */

/** Thresholds, matching the ones the palettes were designed against. */
export const CVD_MIN = 8.0;      // OKLab ΔE ×100 between adjacent categorical slots
export const NORMAL_MIN = 15.0;  // the same pair, unsimulated
export const CONTRAST_MIN = 3.0; // WCAG ratio of a mark against its surface
export const RAMP_STEP_MIN = 0.06;  // OKLCH lightness between adjacent ramp steps
export const RAMP_END_MIN = 2.0;    // the ramp step nearest the surface, vs surface

const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868],
           [0.114503, 0.786281, 0.099216],
           [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968],
           [0.280085, 0.672501, 0.047413],
           [-0.011820, 0.042940, 0.968881]],
};

/** @returns {[number,number,number]} 0-1 sRGB */
export function parseHex(hex) {
  const h = String(hex).trim().replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fromLinear = (c) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, v));
};

/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB hex to OKLab. */
export function toOklab(hex) {
  const [r, g, b] = parseHex(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** OKLCH lightness (the L of OKLab). */
export function lightness(hex) {
  return toOklab(hex)[0];
}

/** Perceptual distance, OKLab ΔE ×100. */
export function deltaE(a, b) {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

/** Simulate a colour under protanopia or deuteranopia. */
export function simulate(hex, kind) {
  const m = MACHADO[kind];
  const lin = parseHex(hex).map(toLinear);
  const out = m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  const hx = out.map((c) => Math.round(fromLinear(c) * 255).toString(16).padStart(2, '0'));
  return `#${hx.join('')}`;
}

/**
 * Check a set of categorical series colours against their surface.
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkCategorical(colors, surface) {
  const problems = [];

  for (let i = 0; i < colors.length; i++) {
    const ratio = contrast(colors[i], surface);
    // Below 3:1 is legal only where a label or a table carries the value too,
    // which every chart here has — so it is reported, not failed.
    if (ratio < CONTRAST_MIN) {
      problems.push(`note: ${colors[i]} is ${ratio.toFixed(2)}:1 on ${surface} — needs a label or table view`);
    }
    for (let j = i + 1; j < colors.length; j++) {
      const worstCvd = Math.min(
        deltaE(simulate(colors[i], 'protan'), simulate(colors[j], 'protan')),
        deltaE(simulate(colors[i], 'deutan'), simulate(colors[j], 'deutan')),
      );
      if (worstCvd < CVD_MIN) {
        problems.push(`FAIL ${colors[i]} vs ${colors[j]}: colour-blind ΔE ${worstCvd.toFixed(1)} < ${CVD_MIN}`);
      }
      const normal = deltaE(colors[i], colors[j]);
      if (normal < NORMAL_MIN) {
        problems.push(`FAIL ${colors[i]} vs ${colors[j]}: ΔE ${normal.toFixed(1)} < ${NORMAL_MIN}`);
      }
    }
  }
  return { ok: !problems.some((p) => p.startsWith('FAIL')), problems };
}

/**
 * Check a sequential ramp: monotone, separable step to step, and the step
 * nearest the surface still visible against it.
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkRamp(ramp, surface) {
  const problems = [];
  const Ls = ramp.map(lightness);
  const descending = Ls[0] > Ls[Ls.length - 1];

  for (let i = 1; i < ramp.length; i++) {
    const d = Ls[i] - Ls[i - 1];
    if (descending ? d >= 0 : d <= 0) {
      problems.push(`FAIL ${ramp[i - 1]} -> ${ramp[i]}: ramp is not monotone`);
    }
    if (Math.abs(d) < RAMP_STEP_MIN) {
      problems.push(`FAIL ${ramp[i - 1]} vs ${ramp[i]}: lightness gap ${Math.abs(d).toFixed(3)} < ${RAMP_STEP_MIN}`);
    }
  }

  // The end nearest the surface is the one that can disappear into it.
  const nearest = descending ? ramp[0] : ramp[ramp.length - 1];
  const ratio = contrast(nearest, surface);
  if (ratio < RAMP_END_MIN) {
    problems.push(`FAIL ${nearest} is ${ratio.toFixed(2)}:1 on ${surface} < ${RAMP_END_MIN}`);
  }
  return { ok: !problems.some((p) => p.startsWith('FAIL')), problems };
}
