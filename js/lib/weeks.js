// 주차 이어가기: per-course week records in localStorage (storage injected so it is testable).

export const STORE_KEY = 'ttak.v1.courses';

export function courseKey(name) {
  return String(name ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()[\]{}·.,\-_/]/g, '');
}

export function loadCourses(storage) {
  try {
    const v = JSON.parse(storage.getItem(STORE_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveCourses(storage, data) {
  storage.setItem(STORE_KEY, JSON.stringify(data));
}

/** "3장 비선형 방정식의 근" → "3장"; otherwise a shortened title. */
export function lectureLabel(slides) {
  const t = slides.find((s) => /\d+\s*장/.test(s.title))?.title || slides[0]?.title || '';
  const m = t.match(/(\d+)\s*장/);
  if (m) return `${m[1]}장`;
  return t.length > 14 ? t.slice(0, 13) + '…' : t;
}

/**
 * Save this week's 진도선. Uncovered slides keep their text so next week can merge them.
 * Slides carried over from an earlier week keep their original label (e.g. "9").
 */
export function saveWeek(storage, { course, week, progress, slides, savedAt = new Date().toISOString() }) {
  const key = courseKey(course);
  if (!key || !week) return null;
  const data = loadCourses(storage);
  const c = data[key] || { name: course, weeks: {} };
  c.name = course;
  const stopped = slides.find((s) => s.index === progress);
  const uncovered = slides
    .filter((s) => s.index > progress)
    .slice(0, 40)
    .map((s) => ({ label: s.label, title: s.title, text: s.text.slice(0, 2000), carriedFrom: s.carriedFrom ?? null }));
  c.weeks[String(week)] = {
    week: Number(week),
    progress,
    total: slides.length,
    stoppedLabel: stopped ? stopped.label : null,
    stoppedTitle: stopped ? stopped.title : null,
    lecture: lectureLabel(slides),
    uncovered,
    savedAt,
  };
  data[key] = c;
  saveCourses(storage, data);
  return c.weeks[String(week)];
}

/**
 * For course + week, find the most recent earlier week and describe where it stopped.
 * @returns null | { fromWeek, lecture, stoppedLabel, stoppedTitle, nextLabel, total, uncovered, message }
 */
export function getCarryOver(storage, course, week) {
  const c = loadCourses(storage)[courseKey(course)];
  if (!c) return null;
  const w = Number(week);
  const prev = Object.values(c.weeks)
    .filter((x) => x.week < w)
    .sort((a, b) => b.week - a.week)[0];
  if (!prev) return null;
  const firstUncovered = prev.uncovered[0];
  const nextLabel = firstUncovered ? firstUncovered.label : null;
  const where = prev.stoppedLabel ? `${prev.lecture ? prev.lecture + ' ' : ''}${prev.stoppedLabel}쪽에서 멈춤` : '진도 없음';
  const message = nextLabel
    ? `지난주(${prev.week}주차) ${where} → 이번 주는 ${nextLabel}쪽부터`
    : `지난주(${prev.week}주차) ${where} — 교안을 끝까지 나갔어요`;
  return {
    fromWeek: prev.week,
    lecture: prev.lecture,
    stoppedLabel: prev.stoppedLabel,
    stoppedTitle: prev.stoppedTitle,
    nextLabel,
    total: prev.total,
    uncovered: prev.uncovered,
    message,
  };
}

/** Prepend last week's uncovered slides to this week's deck and renumber the working index. */
export function mergeCarryOver(carry, slides) {
  const carried = (carry?.uncovered || []).map((u) => ({
    label: u.label,
    title: u.title,
    text: u.text,
    carriedFrom: carry.fromWeek,
  }));
  return [...carried, ...slides.map((s) => ({ ...s }))].map((s, i) => ({ ...s, index: i + 1 }));
}

export function deleteCourse(storage, course) {
  const data = loadCourses(storage);
  delete data[courseKey(course)];
  saveCourses(storage, data);
}

/** Minimal in-memory Storage for tests / private mode. */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
