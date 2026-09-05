// Pure planning for display-part rendering (no Three.js): how parts are grouped
// into instanced batches, how unknown geometry is represented, and which level
// of detail an object gets. Kept separate so it can be unit-tested in Node.
import { geometryForModel } from '../scene/primitives.js';

export const UNKNOWN_MODES = ['simplified', 'boxes', 'hidden'];
export const PERF_MODES = ['auto', 'on', 'off'];
// Performance Mode kicks in automatically above this many display parts.
export const PERF_AUTO_PARTS = 800;
// Adaptive fallback for unknown model IDs (per object).
export const UNKNOWN_BOXES_MAX = 32;   // ≤ this many: normal wireframe boxes
export const UNKNOWN_POINTS_MAX = 400; // ≤ this many: one point per part + bounds
export const CLUSTER_POINTS = 300;     // above: subsampled points + bounds

// Geometry key shared by every part drawn with the same mesh.
export function geometryKey(part) {
  if (part.kind === 'model') return geometryForModel(part.modelId) ? 'm' + part.modelId : 'unknown';
  return 'px' + part.kind;
}

// Split an object's parts into instanced groups. Unknown-model parts form their
// own group so the fallback representation can be chosen per object.
export function planGroups(parts) {
  const groups = new Map();
  let unknown = 0;
  parts.forEach((p, index) => {
    const key = geometryKey(p);
    if (key === 'unknown') unknown++;
    let g = groups.get(key);
    if (!g) { g = { key, kind: p.kind, modelId: p.kind === 'model' ? p.modelId : null, unknown: key === 'unknown', ids: [], indices: [] }; groups.set(key, g); }
    g.ids.push(p.id); g.indices.push(index);
  });
  return { groups, unknownCount: unknown, total: parts.length };
}

// How an object's unknown parts are drawn for a preference + count.
//   boxes   – one wireframe box per part (instanced)
//   points  – one small point per part + a bounding outline
//   cluster – subsampled points + bounding outline (very large groups)
//   hidden  – nothing
export function unknownRepresentation(mode, count) {
  if (mode === 'hidden') return 'hidden';
  if (mode === 'boxes') return 'boxes';
  if (count <= UNKNOWN_BOXES_MAX) return 'boxes';
  if (count <= UNKNOWN_POINTS_MAX) return 'points';
  return 'cluster';
}
export function clusterStride(count) { return Math.max(1, Math.ceil(count / CLUSTER_POINTS)); }

// Whether Performance Mode is active for a preference and a part count.
export function perfModeActive(pref, totalParts) {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return totalParts > PERF_AUTO_PARTS;
}

// Projected radius of a bounding sphere in pixels.
export function pixelRadius(radius, distance, fovDeg, viewportHeightPx, ortho = false, orthoHeightWorld = 1) {
  if (ortho) return radius / Math.max(1e-6, orthoHeightWorld) * viewportHeightPx;
  const halfH = Math.tan((fovDeg * Math.PI / 180) / 2) * Math.max(1e-6, distance);
  return radius / halfH * (viewportHeightPx / 2);
}

// Level of detail for one object.
//   full   – instanced geometry, outlines, transparency
//   medium – instanced geometry, no outlines
//   far    – points + bounding outline only
// Selected objects always get full detail so they stay readable.
export function lodLevel({ pixelRadius: pr, selected = false, perf = false, playing = false }) {
  if (selected) return 'full';
  const far = perf ? 16 : 10, medium = perf ? 64 : 36;
  if (pr < far) return 'far';
  if (pr < medium || (perf && playing)) return 'medium';
  return 'full';
}

// Instance id → part id lookup for a raycast hit on an instanced group.
export function partIdForInstance(group, instanceId) {
  return group && instanceId != null ? group.ids[instanceId] ?? null : null;
}
