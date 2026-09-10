// Fitting a keyed time range into a timeline view (pure, unit-tested in Node).
//
// Used by the Dope Sheet and the Graph Editor when an animation becomes active: the whole
// keyed range is shown, centred, with a little padding, at a zoom that stays usable for a
// single key, for a 0.03 s clip and for a minutes-long one. Purely a view operation.
import { keyTimes } from '../anim/clips.js';

export const ZOOM_MIN = 0.05;   // px per second (20 s per pixel): even a very long clip is never truncated
export const ZOOM_MAX = 4000;   // px per second: 0.03 s keys stay separable, never infinite
export const MIN_SPAN = 0.5;    // seconds shown at least (single key, very short clip)

// Earliest / latest key time over every channel of the clip (bones, objects, IK targets,
// poles, retargeted tracks — anything in clip.tracks), hidden or collapsed channels included.
export function keyRange(clip) {
  const times = clip ? keyTimes(clip) : [];
  if (!times.length) return null;
  return { t0: times[0], t1: times[times.length - 1], count: times.length };
}

// { t0, pxPerSec } for a view of `width` pixels (the key area, labels/axis excluded).
// range = { t0, t1 } or null (empty animation: a default window from just before 0).
export function fitTimeRange(range, width, { pad = null, defaultSpan = 2, minSpan = MIN_SPAN, zoomMin = ZOOM_MIN, zoomMax = ZOOM_MAX } = {}) {
  width = Math.max(40, width || 0);
  const padPx = pad ?? Math.max(16, Math.min(60, width * 0.05));
  if (!range || !Number.isFinite(range.t0) || !Number.isFinite(range.t1)) {
    const pxPerSec = clamp((width - 2 * padPx) / Math.max(minSpan, defaultSpan), zoomMin, zoomMax);
    return { t0: -padPx / pxPerSec, pxPerSec };
  }
  const span = Math.max(minSpan, range.t1 - range.t0);
  const pxPerSec = clamp((width - 2 * padPx) / span, zoomMin, zoomMax);
  const mid = (range.t0 + range.t1) / 2;
  return { t0: mid - width / 2 / pxPerSec, pxPerSec };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// is every key of the range visible with room to spare?
export function rangeVisible(range, view, width, margin = 8) {
  if (!range) return true;
  const x = (t) => (t - view.t0) * view.pxPerSec;
  return x(range.t0) >= margin && x(range.t1) <= width - margin;
}
