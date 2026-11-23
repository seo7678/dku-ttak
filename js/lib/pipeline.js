// Glue: raw inputs → slides, notes, coverage. Shared by the UI and the tests.
import { parseSlides } from './parse.js';
import { parseNotes } from './notes.js';
import { analyzeNotes } from './coverage.js';
import { pageInk, suggestProgress } from './ink.js';

/**
 * Map per-page ink results of THIS week's deck onto a (possibly merged) deck: carried-over slides from last
 * week come first and have no ink. Page-count mismatch: only the overlapping pages are compared.
 * @param {{index:number,carriedFrom?:number}[]} slides
 * @param {{ratios:number[], statuses?:string[], kind?:'mine'|'pan'}} ink
 */
export function mapInk(slides, ink) {
  if (!ink || !ink.ratios?.length) return null;
  const statuses = ink.statuses || pageInk(ink.ratios);
  const own = slides.filter((s) => !s.carriedFrom);
  const st = slides.map(() => 'none');
  const ra = slides.map(() => null);
  own.forEach((s, k) => {
    if (k < statuses.length) {
      st[s.index - 1] = statuses[k];
      ra[s.index - 1] = ink.ratios[k];
    }
  });
  return { statuses: st, ratios: ra, progress: suggestProgress(st), kind: ink.kind || 'mine', compared: Math.min(own.length, statuses.length) };
}

/**
 * @param {object} p
 * @param {object[]} [p.slides] — already parsed slides (PDF or merged deck)
 * @param {string} [p.slidesText]
 * @param {string} [p.notesText] — typed notes
 * @param {{ratios:number[], statuses?:string[], kind?:string}} [p.ink] — per page of this week's deck
 */
export function analyzeLecture({ slides, slidesText, notesText = '', ink = null }) {
  const deck = slides && slides.length ? slides : parseSlides(slidesText || '');
  const notes = parseNotes(notesText || '', deck);
  const mapped = mapInk(deck, ink);
  const coverage = analyzeNotes(deck, notes.items, mapped);
  return { slides: deck, notes, ink: mapped, coverage };
}
