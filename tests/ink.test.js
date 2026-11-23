import test from 'node:test';
import assert from 'node:assert/strict';
import { inkRatio, pageInk, suggestProgress, INK_DEFAULTS } from '../js/lib/ink.js';

const W = 160, H = 90;

// deterministic "printed slide": white page, text-like dark bars and a table rule
function slide() {
  const g = new Uint8Array(W * H).fill(255);
  for (let y = 20; y < 70; y += 10) for (let x = 20; x < 120; x++) { g[y * W + x] = 20; g[(y + 1) * W + x] = 20; }
  for (let y = 15; y < 80; y++) { g[y * W + 130] = 30; }
  return g;
}
function shift(g, dx, dy) {
  const o = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx >= 0 && sx < W && sy >= 0 && sy < H) o[y * W + x] = g[sy * W + sx];
  }
  return o;
}
function boxBlur(g) {
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) { s += g[yy * W + xx]; n++; }
    }
    o[y * W + x] = Math.round(s / n);
  }
  return o;
}
// thick pen strokes (3 px) drawn on blank area, like handwriting
function withStrokes(g, strokes = 3) {
  const o = g.slice();
  for (let k = 0; k < strokes; k++) {
    const y0 = 74 + k * 4;
    for (let x = 20; x < 100; x++) for (let t = 0; t < 3; t++) o[(y0 + t) * W + x] = 10;
  }
  return o;
}

test('identical pages -> 0', () => {
  const b = slide();
  assert.equal(inkRatio(b, b.slice(), W, H), 0);
});

test('whole page shifted 1px and 2px -> below the none threshold', () => {
  const b = slide();
  assert.ok(inkRatio(b, shift(b, 1, 0), W, H) < INK_DEFAULTS.noneBelow);
  assert.ok(inkRatio(b, shift(b, 0, 1), W, H) < INK_DEFAULTS.noneBelow);
  assert.ok(inkRatio(b, shift(b, 1, 1), W, H, { radius: 2 }) < INK_DEFAULTS.noneBelow);
});

test('same content blurred (re-render/antialias) -> below none threshold', () => {
  const b = slide();
  assert.ok(inkRatio(b, boxBlur(b), W, H) < INK_DEFAULTS.noneBelow);
});

test('added pen strokes -> well above ink threshold', () => {
  const b = slide();
  const r = inkRatio(b, withStrokes(b), W, H);
  assert.ok(r > INK_DEFAULTS.inkAtLeast, `ratio ${r}`);
});

test('strokes survive a shift+blur of the rest of the page', () => {
  const b = slide();
  const ann = boxBlur(shift(withStrokes(b), 1, 0));
  assert.ok(inkRatio(b, ann, W, H) > INK_DEFAULTS.inkAtLeast);
});

test('isolated single dark pixels are ignored (speckle)', () => {
  const b = slide();
  const a = b.slice();
  for (let i = 0; i < 10; i++) a[(5 + i * 2) * W + 3 * i + 40] = 0; // none adjacent
  a[5 * W + 3] = 0; // inside margin
  assert.equal(inkRatio(b, a, W, H), 0);
});

test('dark edge line in annotated render is ignored (margin)', () => {
  const b = slide();
  const a = b.slice();
  for (let x = 0; x < W; x++) { a[x] = 0; a[(H - 1) * W + x] = 0; }
  for (let y = 0; y < H; y++) { a[y * W] = 0; a[y * W + W - 1] = 0; }
  assert.equal(inkRatio(b, a, W, H), 0);
});

test('ink painted on top of printed text is not double counted, ink on blank is', () => {
  const b = slide();
  const a = b.slice();
  for (let x = 20; x < 100; x++) { a[20 * W + x] = 0; a[21 * W + x] = 0; } // over already-dark text
  assert.equal(inkRatio(b, a, W, H), 0);
});

test('accepts Uint8ClampedArray (canvas ImageData) and degenerate sizes', () => {
  const b = new Uint8ClampedArray(slide());
  assert.equal(inkRatio(b, new Uint8ClampedArray(withStrokes(slide())), W, H) > 0, true);
  assert.equal(inkRatio(new Uint8Array(0), new Uint8Array(0), 0, 0), 0);
  assert.equal(inkRatio(new Uint8Array(4), new Uint8Array(4), 2, 2), 0);
});

test('pageInk thresholds', () => {
  const { noneBelow, inkAtLeast } = INK_DEFAULTS;
  assert.deepEqual(pageInk([0, noneBelow / 2, noneBelow, (noneBelow + inkAtLeast) / 2, inkAtLeast, 0.05]),
    ['none', 'none', 'light', 'light', 'ink', 'ink']);
  assert.deepEqual(pageInk([]), []);
  assert.deepEqual(pageInk([NaN, undefined]), ['none', 'none']);
  assert.deepEqual(pageInk([0.01], { inkAtLeast: 0.5 }), ['light']);
});

test('suggestProgress edge cases', () => {
  assert.equal(suggestProgress([]), 0);
  assert.equal(suggestProgress(['none', 'none', 'none']), 0);
  assert.equal(suggestProgress(['none', 'ink', 'ink', 'none', 'none']), 3); // title page none, then notes
  assert.equal(suggestProgress(['none', 'ink', 'none', 'ink']), 4);
  assert.equal(suggestProgress(['none', 'ink', 'ink', 'light']), 4); // trailing light counts by default
  assert.equal(suggestProgress(['none', 'ink', 'ink', 'light'], { trailingLight: false }), 3);
  assert.equal(suggestProgress(['light', 'none']), 1);
  assert.equal(suggestProgress(['light', 'none'], { trailingLight: false }), 0);
});
