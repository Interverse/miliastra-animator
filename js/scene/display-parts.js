// Display parts: an object's display model is a small editable collection of
// primitives, kept completely separate from the .gia data.
//
//   .gia object transform → display-model root (node.display pos/rot/scale)
//                          → individual parts (file decorations + custom primitives)
//
// File decorations are parts whose defaults come from the .gia (never changed);
// the user may override a part's transform, name and visibility, and add custom
// cuboid / cylinder / sphere (or duplicated model) parts. Everything lives in
// node.display, which is editor-only project data:
//   { pos, rot, scale,                 root offset (see displayOf)
//     parts: { [partId]: { pos?, rot?, scale?, name?, hidden? } },   file-part overrides
//     custom: [ { id, kind, name, pos, rot, scale, color, modelId?, argb?, hidden, created } ],
//     order: [partId…],                optional explicit ordering
//     nextCustom }
import { v3, quat } from '../core/math.js';

export const filePartId = (d, i) => 'f' + (d.guid ?? i);
export const PART_KINDS = ['cuboid', 'cylinder', 'sphere'];

export function ensureDisplay(node) { if (!node.display) node.display = {}; return node.display; }

// Effective, ordered list of parts with defaults resolved.
export function displayParts(node) {
  const disp = node?.display || {};
  const ov = disp.parts || {};
  const list = [];
  (node?.decorations || []).forEach((d, i) => {
    const id = filePartId(d, i);
    const o = ov[id] || {};
    list.push({
      id, source: 'file', index: i, kind: 'model', modelId: d.modelId, argb: d.argb,
      name: o.name ?? d.name ?? `Part ${i + 1}`,
      pos: o.pos || d.pos, rot: o.rot || d.rot, scale: o.scale || d.scale, hidden: !!o.hidden,
      edited: !!(o.pos || o.rot || o.scale), renamed: o.name != null,
      defaults: { pos: d.pos, rot: d.rot, scale: d.scale },
    });
  });
  for (const c of disp.custom || []) {
    list.push({
      id: c.id, source: 'custom', kind: c.kind, modelId: c.modelId, argb: c.argb, color: c.color,
      name: c.name, pos: c.pos, rot: c.rot, scale: c.scale, hidden: !!c.hidden,
      edited: !sameTransform(c, c.created), renamed: false, defaults: c.created,
    });
  }
  if (disp.order?.length) {
    const rank = new Map(disp.order.map((id, i) => [id, i]));
    list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9 + list.indexOf(a)) - (rank.has(b.id) ? rank.get(b.id) : 1e9 + list.indexOf(b)));
  }
  return list;
}
export function displayPart(node, id) { return displayParts(node).find((p) => p.id === id) || null; }
function sameTransform(a, b) {
  return !!b && v3.dist(a.pos, b.pos) < 1e-9 && quat.angle(a.rot, b.rot) < 1e-9 && a.scale.every((s, i) => Math.abs(s - b.scale[i]) < 1e-9);
}
export function hasPartEdits(node) {
  const d = node?.display;
  return !!d && ((d.parts && Object.keys(d.parts).length > 0) || (d.custom && d.custom.length > 0) || (d.order && d.order.length > 0));
}

// ---------- mutations (plain data; the editor commits them) ----------
function customEntry(node, id) { return (node.display?.custom || []).find((c) => c.id === id) || null; }
export function setPartTransform(node, id, patch) {
  const c = customEntry(node, id);
  if (c) {
    if (patch.pos) c.pos = patch.pos.slice();
    if (patch.rot) c.rot = quat.norm(patch.rot);
    if (patch.scale) c.scale = patch.scale.map((s) => Math.max(1e-4, s));
    return true;
  }
  if (!displayPart(node, id)) return false;
  const disp = ensureDisplay(node);
  disp.parts = disp.parts || {};
  const o = (disp.parts[id] = disp.parts[id] || {});
  if (patch.pos) o.pos = patch.pos.slice();
  if (patch.rot) o.rot = quat.norm(patch.rot);
  if (patch.scale) o.scale = patch.scale.map((s) => Math.max(1e-4, s));
  return true;
}
export function setPartProps(node, id, props) {
  const c = customEntry(node, id);
  if (c) { if (props.name != null) c.name = props.name; if (props.hidden != null) c.hidden = !!props.hidden; return true; }
  if (!displayPart(node, id)) return false;
  const disp = ensureDisplay(node);
  disp.parts = disp.parts || {};
  const o = (disp.parts[id] = disp.parts[id] || {});
  if (props.name != null) o.name = props.name;
  if (props.hidden != null) o.hidden = !!props.hidden;
  if (!o.hidden) delete o.hidden;
  if (!Object.keys(o).length) delete disp.parts[id];
  return true;
}
export function addCustomPart(node, kind, { pos = [0, 0, 0], rot = [0, 0, 0, 1], scale = [0.2, 0.2, 0.2], name = null, color = '#7ec8ff', modelId = null, argb = null } = {}) {
  const disp = ensureDisplay(node);
  disp.custom = disp.custom || [];
  disp.nextCustom = disp.nextCustom || 1;
  const id = 'c' + disp.nextCustom++;
  const kindName = kind.charAt(0).toUpperCase() + kind.slice(1);
  const count = disp.custom.filter((c) => c.kind === kind).length + 1;
  const part = { id, kind, name: name || `${kindName} ${count}`, pos: pos.slice(), rot: quat.norm(rot), scale: scale.slice(), color, hidden: false };
  if (modelId != null) part.modelId = modelId;
  if (argb != null) part.argb = argb;
  part.created = { pos: part.pos.slice(), rot: part.rot.slice(), scale: part.scale.slice() };
  disp.custom.push(part);
  if (disp.order?.length) disp.order.push(id);
  return part;
}
// duplicates become custom parts (file parts keep their geometry via modelId)
export function duplicateParts(node, ids) {
  const out = [];
  for (const id of ids) {
    const p = displayPart(node, id);
    if (!p) continue;
    const c = addCustomPart(node, p.kind === 'model' ? 'model' : p.kind, { pos: p.pos, rot: p.rot, scale: p.scale, name: `${p.name} copy`, color: p.color, modelId: p.modelId, argb: p.argb });
    out.push(c.id);
  }
  return out;
}
// custom parts are removed; file parts are hidden instead (Reset restores them)
export function deleteParts(node, ids) {
  const disp = ensureDisplay(node);
  const result = { removed: [], hidden: [] };
  for (const id of ids) {
    const ci = (disp.custom || []).findIndex((c) => c.id === id);
    if (ci >= 0) { disp.custom.splice(ci, 1); if (disp.order) disp.order = disp.order.filter((x) => x !== id); result.removed.push(id); }
    else if (displayPart(node, id)) { setPartProps(node, id, { hidden: true }); result.hidden.push(id); }
  }
  return result;
}
export function movePart(node, id, dir) {
  const order = displayParts(node).map((p) => p.id);
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return false;
  [order[i], order[j]] = [order[j], order[i]];
  ensureDisplay(node).order = order;
  return true;
}
export function resetPart(node, id) {
  const c = customEntry(node, id);
  if (c) { c.pos = c.created.pos.slice(); c.rot = c.created.rot.slice(); c.scale = c.created.scale.slice(); c.hidden = false; return true; }
  const disp = node.display;
  if (disp?.parts?.[id]) { delete disp.parts[id]; if (!Object.keys(disp.parts).length) delete disp.parts; return true; }
  return false;
}
// Reset Entire Display Model: root offset and every file part back to the .gia /
// reference definition, custom parts back to their creation state.
export function resetDisplayAll(node) {
  const disp = node.display;
  if (!disp) return;
  const custom = (disp.custom || []).map((c) => ({ ...c, pos: c.created.pos.slice(), rot: c.created.rot.slice(), scale: c.created.scale.slice(), hidden: false }));
  if (custom.length) node.display = { custom, nextCustom: disp.nextCustom };
  else delete node.display;
}

// ---------- transforms ----------
// rootFrame: world transform of the display root (object world ∘ root offset);
// rootScale: zoom ⊙ root scale (applied to part positions and sizes)
export function partWorld(rootFrame, rootScale, part) {
  return { pos: v3.add(rootFrame.pos, quat.rotate(rootFrame.rot, v3.mul(rootScale, part.pos))), rot: quat.norm(quat.mul(rootFrame.rot, part.rot)) };
}
export function worldToPart(rootFrame, rootScale, world) {
  const inv = quat.conj(rootFrame.rot);
  const rel = quat.rotate(inv, v3.sub(world.pos, rootFrame.pos));
  return { pos: rel.map((x, i) => x / (rootScale[i] || 1)), rot: quat.norm(quat.mul(inv, world.rot)) };
}
