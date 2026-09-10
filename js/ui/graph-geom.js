// Pure geometry for the Graph Editor (no DOM): view mapping, curve sampling, hit tests,
// box selection and axis ticks. Kept separate so it is unit-tested in Node.
import { evaluateComponent } from '../anim/curves.js';

// view = { t0, pxPerSec, vCenter, pxPerUnit, left, top, w, h }
//   left/top: pixel origin of the plot area; w/h: its size.
export const xOf = (view, t) => view.left + (t - view.t0) * view.pxPerSec;
export const timeAt = (view, x) => view.t0 + (x - view.left) / view.pxPerSec;
export const yOf = (view, v) => view.top + view.h / 2 - (v - view.vCenter) * view.pxPerUnit;
export const valueAt = (view, y) => view.vCenter - (y - view.top - view.h / 2) / view.pxPerUnit;

// A view that shows the time range [t0,t1] and value range [v0,v1] with margins.
export function fitView(view, { t0, t1, v0, v1 }, { marginPx = 28, minSpan = 1e-3 } = {}) {
  const ts = Math.max(minSpan, t1 - t0), vs = Math.max(minSpan, v1 - v0);
  const w = Math.max(40, view.w - 2 * marginPx), h = Math.max(30, view.h - 2 * marginPx);
  const pxPerSec = Math.max(10, Math.min(5000, w / ts));
  const pxPerUnit = Math.max(1e-4, Math.min(1e6, h / vs));
  return { ...view, pxPerSec, pxPerUnit, t0: t0 - marginPx / pxPerSec, vCenter: (v0 + v1) / 2 };
}

// "nice" tick step (1, 2, 5 × 10^n) giving at least minPx pixels between ticks
export function niceStep(pxPerUnit, minPx = 40) {
  const raw = minPx / pxPerUnit;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

// Sample one channel between tStart and tEnd for drawing: every key inside the range is a
// sample, and eased segments get extra samples proportional to their pixel width.
// Returns [{ t, v, key: index|null }].
export function sampleChannel(keys, ch, comp, es, tStart, tEnd, pxPerSec, maxPerSegment = 48) {
  const out = [];
  if (!keys.length) return out;
  const val = (i) => (ch === 'rot' ? (es ? es[i] : keys[i].e)[comp] : keys[i].v[comp]);
  // flat extension before the first / after the last key
  if (tStart < keys[0].t) out.push({ t: Math.min(tStart, keys[0].t), v: val(0), key: null });
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (i > 0 && k.t < tStart && keys[i].t < tStart && (i + 1 < keys.length ? keys[i + 1].t < tStart : true)) continue; // wholly before the window
    if (k.t > tEnd && (i === 0 || keys[i - 1].t > tEnd)) break;
    out.push({ t: k.t, v: val(i), key: i });
    if (i === keys.length - 1) break;
    const b = keys[i + 1];
    if (k.i === 'step') { out.push({ t: b.t, v: val(i), key: null }); continue; }
    if (k.i !== 'ease') continue;
    const px = (b.t - k.t) * pxPerSec;
    const n = Math.max(2, Math.min(maxPerSegment, Math.ceil(px / 4)));
    for (let j = 1; j < n; j++) { const t = k.t + (b.t - k.t) * (j / n); out.push({ t, v: evaluateComponent(keys, t, ch, comp, es), key: null }); }
  }
  const last = keys[keys.length - 1];
  if (tEnd > last.t) out.push({ t: Math.max(tEnd, last.t), v: val(keys.length - 1), key: null });
  return out;
}

// nearest of `points` ([{x,y,…}]) within radius r pixels of (x,y), or null
export function hitPoint(points, x, y, r = 6) {
  let best = null, bd = r * r;
  for (const p of points) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d <= bd) { bd = d; best = p; } }
  return best;
}
export function pointsInBox(points, x0, y0, x1, y1) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  return points.filter((p) => p.x >= ax && p.x <= bx && p.y >= ay && p.y <= by);
}
// distance from (x,y) to the polyline segment a→b (for clicking on a curve)
export function distToSegment(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const u = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
  return Math.hypot(x - (a.x + u * dx), y - (a.y + u * dy));
}
