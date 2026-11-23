// Pinned third-party code, loaded on demand from jsDelivr: pdf.js (PDF text + page images for ink detection)
// and qrcode-generator (발표 모드 QR).

export const PDFJS_VERSION = '4.10.38';
const PDF_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;
const QR_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const QR_SRI = 'sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k';

let pdfPromise;
export function loadPdfjs() {
  pdfPromise ||= import(PDF_BASE + 'build/pdf.min.mjs').then((lib) => {
    const workerUrl = PDF_BASE + 'build/pdf.worker.min.mjs';
    try {
      // Cross-origin module workers are not allowed directly; a same-origin blob that imports the CDN module is.
      const blob = new Blob([`import ${JSON.stringify(workerUrl)};`], { type: 'text/javascript' });
      lib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: 'module' });
    } catch {
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
    }
    return lib;
  });
  pdfPromise.catch(() => {
    pdfPromise = null;
  });
  return pdfPromise;
}

/** Open a PDF File with pdf.js. Fails loudly (instead of hanging) if the worker cannot start. */
async function openDoc(file) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: PDF_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDF_BASE + 'standard_fonts/',
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      task.destroy();
      pdfPromise = null;
      reject(new Error('PDF 처리기가 응답하지 않아요'));
    }, 45000);
  });
  return Promise.race([task.promise, timeout]).finally(() => clearTimeout(timer));
}

/** Render one page onto a white canvas `width` px wide (height from the page ratio, or forced to `height`). */
async function renderPage(page, width, height) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (!height || height === c.height) return c;
  // Annotated exports sometimes have a slightly different page box: resample to the clean page's size.
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = height;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(c, 0, 0, out.width, out.height);
  return out;
}

/**
 * Per-page grayscale renders (Uint8Array, 0..255) for ink detection.
 * @param {File} file
 * @param {{width?:number, sizes?:{width:number,height:number}[], onProgress?:(i:number,n:number)=>void}} [o]
 *   sizes: force page i to this size (used to match the annotated deck to the clean deck pixel for pixel)
 */
export async function renderGrayPages(file, { width = 320, sizes = null, onProgress } = {}) {
  const doc = await openDoc(file);
  const out = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const target = sizes?.[i - 1];
      const c = await renderPage(page, target ? target.width : width, target ? target.height : null);
      const { data } = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
      const gray = new Uint8Array(c.width * c.height);
      for (let k = 0, p = 0; k < gray.length; k++, p += 4) gray[k] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
      out.push({ gray, width: c.width, height: c.height });
      page.cleanup();
      onProgress?.(i, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** JPEG (base64, no data: prefix) of selected 1-based pages, `width` px wide — sent to Gemini as images. */
export async function renderJpegPages(file, pageNumbers, { width = 1024, quality = 0.82, onProgress } = {}) {
  const doc = await openDoc(file);
  const out = [];
  try {
    const want = pageNumbers.filter((p) => p >= 1 && p <= doc.numPages);
    for (const [k, p] of want.entries()) {
      const page = await doc.getPage(p);
      const c = await renderPage(page, width, null);
      out.push({ page: p, mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', quality).split(',')[1] });
      page.cleanup();
      onProgress?.(k + 1, want.length);
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** Extract per-page text. Items on the same line are joined without inserting spaces inside Korean words. */
export async function extractPdfPages(file, onProgress) {
  const doc = await openDoc(file);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let out = '';
    let lastY = null;
    let lastEnd = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      if (lastY !== null && Math.abs(y - lastY) > size * 0.6) out += '\n';
      else if (lastEnd !== null && x - lastEnd > size * 0.18 && !out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
      out += it.str;
      if (it.hasEOL) {
        out += '\n';
        lastY = null;
        lastEnd = null;
      } else {
        lastY = y;
        lastEnd = x + (it.width || 0);
      }
    }
    pages.push(out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim());
    onProgress?.(i, doc.numPages);
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

let qrPromise;
function loadQrLib() {
  if (globalThis.qrcode) return Promise.resolve(globalThis.qrcode);
  qrPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = QR_URL;
    s.integrity = QR_SRI;
    s.crossOrigin = 'anonymous';
    s.onload = () => (globalThis.qrcode ? resolve(globalThis.qrcode) : reject(new Error('qrcode missing')));
    s.onerror = () => {
      qrPromise = null;
      reject(new Error('QR 라이브러리를 불러오지 못했어요'));
    };
    document.head.append(s);
  });
  return qrPromise;
}

/** Build an <svg> QR code for text using DOM APIs (no innerHTML). */
export async function qrSvg(text) {
  const qrcode = await loadQrLib();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const size = n + margin * 2;
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', `0 0 ${size} ${size}`);
  el.setAttribute('shape-rendering', 'crispEdges');
  el.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#ffffff');
  el.append(bg);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#202020');
  el.append(path);
  return el;
}
