// Glue: raw inputs → slides, chunks, coverage. Shared by the UI and the tests.
import { parseSlides, parseTranscript, chunkTranscript } from './parse.js';
import { analyzeCoverage } from './coverage.js';

export function analyzeLecture({ slides, slidesText, transcriptText, transcriptName = '' }) {
  const deck = slides && slides.length ? slides : parseSlides(slidesText || '');
  const tr = parseTranscript(transcriptText || '', transcriptName);
  const chunks = chunkTranscript(tr.segments);
  const coverage = analyzeCoverage(deck, chunks);
  return { slides: deck, transcriptFormat: tr.format, segments: tr.segments, chunks, coverage };
}
