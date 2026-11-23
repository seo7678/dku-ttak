// ink.js - deterministic handwriting ("ink") detector for lecture-slide pages.
//
// Compares a clean (수업용) page with the annotated (필기포함) page, both grayscale
// 0..255 at the SAME pixel size, and reports the share of pixels that are NEW dark ink.
//
// Method (explainable in one sentence): a pixel is "new ink" when the annotated pixel is
// darker than the DARKEST clean pixel within `radius` px of it by more than `delta`.
// Printed content that merely moved 1-2 px or got re-antialiased always has a dark clean
// neighbour, so it never counts; handwriting over blank/light areas does. Isolated single
// pixels (fewer than `minNeighbors` other ink pixels in the 3x3 window) are dropped as noise.
//
// DEFAULTS - measured, not guessed (eval/INK_RESULTS.md, eval/ink_eval.mjs, 320 px renders,
// 9 real pairs, 55 hand-checked pages: 31 visibly clean, 24 with handwriting):
//   * plain abs-diff>60 (radius 0, no speckle filter): 12 of 31 clean pages flagged, up to 7.9%
//     of pixels, because Week 1/2 annotated exports are re-rendered (scale, antialias, 1-3 px
//     line shifts).
//   * radius 1 + minNeighbors 3 + delta 60 + margin 2: all 31 clean pages <= 0.018% (0.00018),
//     23 of 24 handwritten pages > 0.00018 (the miss is a pale highlighter stroke).
//   * radius 0 can only be saved by delta>=90 which loses recall (67%); radius>=2 loses recall.
//   * noneBelow 0.0002 sits just above the clean-page maximum (0.00018); inkAtLeast 0.0008 splits
//     tick/circle-only pages ('light', 0.02-0.08%) from substantive notes ('ink').
//   * trailingLight true: every 'light' page in the hand set was real handwriting.
export const INK_DEFAULTS = {
  radius: 1,        // px search radius in the clean page (min-filter)
  delta: 60,        // gray levels the annotation must be darker than the clean neighbourhood
  minNeighbors: 3,  // other ink pixels required in 3x3 to keep a pixel (drops speckle)
  margin: 2,        // px border ignored: annotated exports render a 1px dark page-edge line
  noneBelow: 0.0002, // ratio < noneBelow  -> 'none'
  inkAtLeast: 0.0008,// ratio >= inkAtLeast -> 'ink'; in between -> 'light'
  trailingLight: true,  // suggestProgress: do trailing 'light' pages count as taught?
};

// Separable running minimum over a (2r+1) window, edge-clamped.
function minFilter(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 255;
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) { const v = src[row + k]; if (v < m) m = v; }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 255;
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let k = a; k <= b; k++) { const v = tmp[k * w + x]; if (v < m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Share (0..1) of pixels that are new dark ink on the annotated page. */
export function inkRatio(baseGray, annGray, width, height, opts = {}) {
  const { radius, delta, minNeighbors, margin } = { ...INK_DEFAULTS, ...opts };
  const n = width * height;
  if (!n || baseGray.length < n || annGray.length < n) return 0;
  const dark = minFilter(baseGray, width, height, radius);
  const m = Math.min(margin, (Math.min(width, height) - 1) >> 1);
  const mask = new Uint8Array(n);
  for (let y = m; y < height - m; y++) {
    for (let x = m; x < width - m; x++) {
      const i = y * width + x;
      mask[i] = annGray[i] < dark[i] - delta ? 1 : 0;
    }
  }
  let count = 0;
  for (let y = m; y < height - m; y++) {
    for (let x = m; x < width - m; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (minNeighbors > 0) {
        let nb = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx || dy) && xx >= 0 && xx < width) nb += mask[yy * width + xx];
          }
        }
        if (nb < minNeighbors) continue;
      }
      count++;
    }
  }
  const inner = (width - 2 * m) * (height - 2 * m);
  return inner > 0 ? count / inner : 0;
}

/** ratios -> per-page 'ink' | 'light' | 'none'. */
export function pageInk(ratios, opts = {}) {
  const { noneBelow, inkAtLeast } = { ...INK_DEFAULTS, ...opts };
  return ratios.map((r) => (!(r >= noneBelow) ? 'none' : r >= inkAtLeast ? 'ink' : 'light'));
}

/** 1-based last page judged taught from ink; 0 when no page qualifies. */
export function suggestProgress(statuses, opts = {}) {
  const { trailingLight } = { ...INK_DEFAULTS, ...opts };
  for (let i = statuses.length - 1; i >= 0; i--) {
    if (statuses[i] === 'ink' || (trailingLight && statuses[i] === 'light')) return i + 1;
  }
  return 0;
}
