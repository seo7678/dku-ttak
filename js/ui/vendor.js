// Pinned third-party code, loaded on demand from jsDelivr: pdf.js (PDF text) and qrcode-generator (발표 모드 QR).

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

/** Extract per-page text. Items on the same line are joined without inserting spaces inside Korean words. */
export async function extractPdfPages(file, onProgress) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: PDF_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDF_BASE + 'standard_fonts/',
  });
  // If the worker cannot start (blocked network/CSP), pdf.js waits forever; fail loudly instead.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      task.destroy();
      pdfPromise = null;
      reject(new Error('PDF 처리기가 응답하지 않아요'));
    }, 45000);
  });
  const doc = await Promise.race([task.promise, timeout]).finally(() => clearTimeout(timer));
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
  bg.setAttribute('fill', '#fff');
  el.append(bg);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#161c28');
  el.append(path);
  return el;
}
