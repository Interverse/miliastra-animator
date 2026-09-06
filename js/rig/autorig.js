// Experimental Auto-Rig: analyse an object layout and propose a bone hierarchy.
//
// Pure heuristics (no DOM): world-space bounds of every object's display parts,
// left/right symmetry pairs, a centre column, name hints where present, and a
// model-type classifier (humanoid / quadruped / bird / segmented) that reports a
// confidence rather than pretending to be sure. The proposal is a plain data
// structure the editor can preview, edit and then apply as ONE undo step.
// Templates live in TEMPLATES so more body plans can be added later.
import { getNode, worldTransforms } from '../scene/scene.js';
import { displayParts } from '../scene/display-parts.js';
import { v3, quat, xf } from '../core/math.js';

export const RIG_TYPES = ['auto', 'humanoid', 'quadruped', 'bird', 'segmented'];
// Standard, deterministic rest poses per template ("detected" keeps the imported pose).
export const BASE_POSES = { humanoid: ['tpose', 'apose', 'detected'], quadruped: ['standing', 'detected'], bird: ['spread', 'detected'], segmented: ['straight', 'detected'] };
export const DEFAULT_POSE = { humanoid: 'tpose', quadruped: 'standing', bird: 'spread', segmented: 'straight' };

// ---------- object features ----------
const NAME_HINTS = [
  ['head', /head|skull|face|helmet/i], ['neck', /neck/i], ['chest', /chest|torso|jacket|shirt|ribs|upper_?body/i], ['hips', /hip|pelvis|waist|pants|belt|lower_?body/i], ['spine', /spine|back|abdomen|belly|stomach/i],
  ['upperArm', /upper_?arm|shoulder|bicep/i], ['forearm', /fore_?arm|lower_?arm|elbow/i], ['hand', /hand|palm|glove|fist|wrist/i],
  ['thigh', /thigh|upper_?leg|hip_?joint/i], ['shin', /shin|calf|lower_?leg|knee/i], ['foot', /foot|feet|shoe|boot|paw|hoof/i],
  ['wing', /wing/i], ['tail', /tail/i], ['leg', /\bleg/i],
];
const SIDE_HINT = (name) => (/(^|[_\-. ])(l|left)([_\-. ]|$)/i.test(name) ? 'L' : /(^|[_\-. ])(r|right)([_\-. ]|$)/i.test(name) ? 'R' : null);
function nameHint(name) { for (const [key, re] of NAME_HINTS) if (re.test(name || '')) return key; return null; }

export function objectFeatures(project, ids = null) {
  const world = worldTransforms(project, null);
  const objs = project.nodes.filter((n) => n.type === 'object' && (!ids || ids.includes(n.id)));
  const feats = [];
  for (const o of objs) {
    const w = world.get(o.id); if (!w) continue;
    const zoom = o.zoom || [1, 1, 1];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const parts = displayParts(o).filter((p) => !p.hidden);
    const add = (pt) => { for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], pt[i]); max[i] = Math.max(max[i], pt[i]); } };
    if (parts.length) {
      for (const p of parts) {
        const lp = [p.pos[0] * zoom[0], p.pos[1] * zoom[1], p.pos[2] * zoom[2]];
        const r = Math.max(...p.scale.map((s, i) => Math.abs(s) * zoom[i])) * 0.5;
        const wp = v3.add(w.pos, quat.rotate(w.rot, lp));
        add(v3.add(wp, [r, r, r])); add(v3.sub(wp, [r, r, r]));
      }
    } else { add(v3.add(w.pos, [0.05, 0.05, 0.05])); add(v3.sub(w.pos, [0.05, 0.05, 0.05])); }
    const size = v3.sub(max, min);
    feats.push({ id: o.id, name: o.name, node: o, world: w, min, max, size, center: v3.scale(v3.add(min, max), 0.5), parts: parts.length, hint: nameHint(o.name), side: SIDE_HINT(o.name), parentBone: o.parent ? getNode(project, o.parent)?.type === 'bone' : false });
  }
  return feats;
}

function bounds(feats) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const f of feats) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], f.min[i]); max[i] = Math.max(max[i], f.max[i]); }
  return { min, max, size: v3.sub(max, min), center: v3.scale(v3.add(min, max), 0.5) };
}
// Robust model bounds: the spread of object CENTRES grown by the median object
// size, so one oversized piece (a coat, a cape) cannot dominate the layout.
function robustBounds(feats) {
  if (feats.length === 1) return bounds(feats);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const f of feats) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], f.center[i]); max[i] = Math.max(max[i], f.center[i]); }
  const med = [0, 1, 2].map((i) => { const v = feats.map((f) => f.size[i]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; });
  for (let i = 0; i < 3; i++) { min[i] -= med[i] * 0.5; max[i] += med[i] * 0.5; }
  return { min, max, size: v3.sub(max, min), center: v3.scale(v3.add(min, max), 0.5) };
}

// mirrored pairs across the x centreline
function findPairs(feats, cx, scale) {
  const used = new Set(); const pairs = [];
  const off = feats.filter((f) => Math.abs(f.center[0] - cx) > 0.035 * scale).sort((a, b) => a.center[1] - b.center[1]);
  for (const a of off) {
    if (used.has(a.id)) continue;
    let best = null, bestD = Infinity;
    for (const b of off) {
      if (b === a || used.has(b.id) || Math.sign(b.center[0] - cx) === Math.sign(a.center[0] - cx)) continue;
      const d = Math.abs((a.center[0] - cx) + (b.center[0] - cx)) + Math.abs(a.center[1] - b.center[1]) + Math.abs(a.center[2] - b.center[2]) + 0.5 * v3.len(v3.sub(a.size, b.size));
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best && bestD < 0.35 * scale) { used.add(a.id); used.add(best.id); pairs.push([a, best].sort((p, q) => q.center[0] - p.center[0])); } // [L(+x), R(-x)]
  }
  return { pairs, paired: used };
}

// ---------- classification ----------
export function classify(feats) {
  if (feats.length < 2) return { type: 'segmented', confidence: 0.2, scores: {} };
  const B = robustBounds(feats);
  const [W, H, D] = B.size;
  const scale = Math.max(W, H, D) || 1;
  const cx = B.center[0];
  const { pairs } = findPairs(feats, cx, scale);
  const central = feats.filter((f) => Math.abs(f.center[0] - cx) <= 0.035 * scale);
  const upperPairs = pairs.filter(([a]) => a.center[1] > B.min[1] + 0.45 * H).length;
  const lowerPairs = pairs.filter(([a]) => a.center[1] <= B.min[1] + 0.45 * H).length;
  const widePairs = pairs.filter(([a, b]) => Math.abs(a.center[0] - b.center[0]) > 0.6 * Math.max(H, D)).length;
  const hints = feats.map((f) => f.hint).filter(Boolean);
  // a chain of pieces lying on one line is segmented, however "mirrored" its ends look
  const axis = B.size.indexOf(Math.max(...B.size));
  const collinear = feats.length >= 3 && feats.every((f) => [0, 1, 2].every((i) => i === axis || Math.abs(f.center[i] - B.center[i]) < 0.06 * scale));
  const pairCount = collinear ? 0 : pairs.length;
  const scores = {
    humanoid: (H > 1.1 * Math.max(W, D) ? 0.35 : 0) + (!collinear && upperPairs >= 1 ? 0.2 : 0) + (!collinear && lowerPairs >= 1 ? 0.2 : 0) + (central.length >= 2 ? 0.1 : 0) + (hints.some((h) => ['upperArm', 'forearm', 'hand', 'thigh', 'shin'].includes(h)) ? 0.15 : 0),
    quadruped: (Math.max(W, D) > 1.15 * H ? 0.35 : 0) + (!collinear && lowerPairs >= 2 ? 0.35 : !collinear && lowerPairs === 1 ? 0.1 : 0) + (hints.some((h) => ['paw', 'tail', 'leg'].includes(h)) ? 0.1 : 0) + (upperPairs === 0 ? 0.1 : 0),
    bird: (!collinear && widePairs >= 1 ? 0.45 : 0) + (hints.includes('wing') ? 0.4 : 0) + (W > 1.4 * D ? 0.1 : 0),
    segmented: (pairCount === 0 && feats.length >= 3 ? 0.45 : 0) + (collinear ? 0.25 : 0) + (central.length >= feats.length * 0.8 ? 0.1 : 0),
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [type, top] = ranked[0];
  const margin = top - (ranked[1]?.[1] ?? 0);
  // never claim certainty: heuristics top out at 95 %
  return { type, confidence: Math.max(0, Math.min(0.95, top * 0.7 + margin * 0.6)), scores, pairs: pairCount, central: central.length, collinear };
}

// ---------- templates ----------
const boneSpec = (key, name, parent, head, tail, objects, conf = 0.7) => ({ key, name, parentKey: parent, head: head.slice(), tail: tail.slice(), objects: objects.map((f) => f.id), confidence: conf });
const centerTop = (f) => [f.center[0], f.max[1], f.center[2]];
const centerBottom = (f) => [f.center[0], f.min[1], f.center[2]];

function humanoid(feats, B) {
  const scale = Math.max(...B.size) || 1;
  const cx = B.center[0], H = B.size[1];
  const { pairs, paired } = findPairs(feats, cx, scale);
  const central = feats.filter((f) => !paired.has(f.id)).sort((a, b) => a.center[1] - b.center[1]);
  const bones = [], unassigned = [], notes = [];
  // centre column: hips (lowest) … head (highest); hints override order when present
  // every object belongs to exactly one bone: hinted roles are claimed first, the rest by height
  const byHint = (k) => central.find((f) => f.hint === k);
  const head = byHint('head') || central[central.length - 1];
  const chestHint = byHint('chest'), neckHint = byHint('neck'), hipsHint = byHint('hips');
  const free = central.filter((f) => f !== head && f !== chestHint && f !== neckHint && f !== hipsHint);
  const hips = hipsHint || free[0] || null;
  const rest1 = free.filter((f) => f !== hips);
  const neck = neckHint || (rest1.length >= 2 && rest1[rest1.length - 1].size[1] < 0.12 * H ? rest1[rest1.length - 1] : null);
  const chestCands = rest1.filter((f) => f !== neck);
  const chest = chestHint || chestCands[chestCands.length - 1] || null;
  const spineObjs = chestCands.filter((f) => f !== chest);
  const hipsPos = hips ? hips.center : (chest ? centerBottom(chest) : B.center);
  const chestPos = chest ? chest.center : hips ? centerTop(hips) : v3.add(hipsPos, [0, 0.3 * H, 0]);
  const neckPos = neck ? neck.center : head ? centerBottom(head) : v3.add(chestPos, [0, 0.15 * H, 0]);
  const headTop = head ? centerTop(head) : v3.add(neckPos, [0, 0.15 * H, 0]);
  if (hips) bones.push(boneSpec('hips', 'Hips', null, hipsPos, spineObjs.length ? spineObjs[0].center : chestPos, [hips], hips.hint === 'hips' ? 0.9 : 0.6));
  else bones.push(boneSpec('hips', 'Hips', null, hipsPos, chestPos, [], 0.4));
  let last = 'hips';
  spineObjs.forEach((f, i) => { bones.push(boneSpec('spine' + (i + 1), 'Spine' + (spineObjs.length > 1 ? ' ' + (i + 1) : ''), last, f.center, spineObjs[i + 1]?.center || chestPos, [f], 0.6)); last = 'spine' + (i + 1); });
  bones.push(boneSpec('chest', 'Chest', last, chestPos, neckPos, chest ? [chest] : [], chest?.hint === 'chest' ? 0.9 : chest ? 0.6 : 0.3));
  bones.push(boneSpec('neck', 'Neck', 'chest', neckPos, head ? centerBottom(head) : headTop, neck ? [neck] : [], neck ? 0.8 : 0.4));
  if (head && head !== hips) bones.push(boneSpec('head', 'Head', 'neck', centerBottom(head), headTop, [head], head.hint === 'head' ? 0.95 : 0.6));
  // limbs
  const ARM = ['upperArm', 'forearm', 'hand'], LEG = ['thigh', 'shin', 'foot', 'leg'];
  const hinted = pairs.some(([a]) => ARM.includes(a.hint) || LEG.includes(a.hint));
  let armPairs;
  if (hinted) armPairs = pairs.filter(([a]) => ARM.includes(a.hint) || (!LEG.includes(a.hint) && a.center[1] > B.min[1] + 0.5 * H));
  else {
    // arms hang further from the centre column than legs: split at the largest gap in |dx|
    const dx = pairs.map(([a]) => Math.abs(a.center[0] - cx)).sort((p, q) => p - q);
    let split = Infinity, gap = 0;
    for (let i = 1; i < dx.length; i++) if (dx[i] - dx[i - 1] > gap) { gap = dx[i] - dx[i - 1]; split = dx[i]; }
    armPairs = gap > 0.02 * scale ? pairs.filter(([a]) => Math.abs(a.center[0] - cx) >= split) : pairs.filter(([a]) => a.center[1] > B.min[1] + 0.5 * H);
  }
  const legPairs = pairs.filter((p) => !armPairs.includes(p));
  for (const [side, idx] of [['L', 0], ['R', 1]]) {
    const arm = armPairs.map((p) => p[idx]).sort((a, b) => Math.abs(a.center[0] - cx) - Math.abs(b.center[0] - cx));
    const order = ['upperArm', 'forearm', 'hand'];
    const armObjs = order.map((k) => arm.find((f) => f.hint === k) || null);
    let rest = arm.filter((f) => !armObjs.includes(f));
    for (let i = 0; i < 3 && rest.length; i++) if (!armObjs[i]) armObjs[i] = rest.shift();
    for (const f of rest) unassigned.push(f.id);
    if (armObjs[0] || armObjs[1] || armObjs[2]) {
      const shoulder = armObjs[0] ? [armObjs[0].center[0] - Math.sign(armObjs[0].center[0] - cx) * armObjs[0].size[0] * 0.5, armObjs[0].max[1], armObjs[0].center[2]] : chestPos;
      const elbow = armObjs[1] ? centerTop(armObjs[1]) : armObjs[0] ? [armObjs[0].center[0], armObjs[0].min[1], armObjs[0].center[2]] : null;
      const wrist = armObjs[2] ? centerTop(armObjs[2]) : armObjs[1] ? [armObjs[1].center[0], armObjs[1].min[1], armObjs[1].center[2]] : null;
      const handEnd = armObjs[2] ? centerBottom(armObjs[2]) : wrist ? v3.add(wrist, [0, -0.1 * H, 0]) : null;
      bones.push(boneSpec('shoulder' + side, `Shoulder.${side}`, 'chest', v3.add(chestPos, [(shoulder[0] - chestPos[0]) * 0.4, (shoulder[1] - chestPos[1]) * 0.4, 0]), shoulder, [], 0.5));
      if (elbow) bones.push(boneSpec('upperArm' + side, `Upper Arm.${side}`, 'shoulder' + side, shoulder, elbow, armObjs[0] ? [armObjs[0]] : [], armObjs[0]?.hint === 'upperArm' ? 0.9 : 0.6));
      if (elbow && wrist) bones.push(boneSpec('forearm' + side, `Forearm.${side}`, 'upperArm' + side, elbow, wrist, armObjs[1] ? [armObjs[1]] : [], armObjs[1]?.hint === 'forearm' ? 0.9 : 0.6));
      if (wrist && handEnd) bones.push(boneSpec('hand' + side, `Hand.${side}`, 'forearm' + side, wrist, handEnd, armObjs[2] ? [armObjs[2]] : [], armObjs[2]?.hint === 'hand' ? 0.9 : 0.6));
    }
    const leg = legPairs.map((p) => p[idx]).sort((a, b) => b.center[1] - a.center[1]);
    const lorder = ['thigh', 'shin', 'foot'];
    const legObjs = lorder.map((k) => leg.find((f) => f.hint === k) || null);
    rest = leg.filter((f) => !legObjs.includes(f));
    for (let i = 0; i < 3 && rest.length; i++) if (!legObjs[i]) legObjs[i] = rest.shift();
    for (const f of rest) unassigned.push(f.id);
    if (legObjs[0] || legObjs[1] || legObjs[2]) {
      const hip = legObjs[0] ? centerTop(legObjs[0]) : legObjs[1] ? v3.add(centerTop(legObjs[1]), [0, 0.2 * H, 0]) : null;
      const knee = legObjs[1] ? centerTop(legObjs[1]) : legObjs[0] ? centerBottom(legObjs[0]) : null;
      const ankle = legObjs[2] ? centerTop(legObjs[2]) : legObjs[1] ? centerBottom(legObjs[1]) : null;
      const toe = legObjs[2] ? [legObjs[2].center[0], legObjs[2].min[1], legObjs[2].center[2] + (legObjs[2].size[2] >= legObjs[2].size[0] ? -1 : 0) * legObjs[2].size[2] * 0.4] : null;
      if (hip && knee) bones.push(boneSpec('thigh' + side, `Thigh.${side}`, 'hips', hip, knee, legObjs[0] ? [legObjs[0]] : [], legObjs[0]?.hint === 'thigh' ? 0.9 : 0.6));
      if (knee && ankle) bones.push(boneSpec('shin' + side, `Shin.${side}`, 'thigh' + side, knee, ankle, legObjs[1] ? [legObjs[1]] : [], legObjs[1]?.hint === 'shin' ? 0.9 : 0.6));
      if (ankle && toe) bones.push(boneSpec('foot' + side, `Foot.${side}`, 'shin' + side, ankle, toe, legObjs[2] ? [legObjs[2]] : [], legObjs[2]?.hint === 'foot' ? 0.9 : 0.6));
    }
  }
  const ik = [];
  for (const side of ['L', 'R']) {
    if (bones.some((b) => b.key === 'shin' + side)) ik.push({ boneKey: 'shin' + side, name: `Leg IK.${side}`, chainLength: 2, poleDir: [0, 0, -1] });
    if (bones.some((b) => b.key === 'forearm' + side)) ik.push({ boneKey: 'forearm' + side, name: `Arm IK.${side}`, chainLength: 2, poleDir: [0, 0, 1] });
  }
  return { bones, unassigned, notes, ik };
}

function quadruped(feats, B) {
  const scale = Math.max(...B.size) || 1;
  const [W, H, D] = B.size;
  const axis = W >= D ? 0 : 2; // body runs along the longer horizontal axis
  const side = axis === 0 ? 2 : 0;
  const c = B.center;
  const s = (f) => f.center[axis] - c[axis];
  const low = feats.filter((f) => f.center[1] < B.min[1] + 0.5 * H && Math.abs(f.center[side] - c[side]) > 0.05 * scale);
  const central = feats.filter((f) => !low.includes(f)).sort((a, b) => s(a) - s(b));
  const bones = [], unassigned = [], notes = [];
  const head = central.find((f) => f.hint === 'head') || central.reduce((best, f) => (!best || f.center[1] + Math.abs(s(f)) * 0.5 > best.center[1] + Math.abs(s(best)) * 0.5 ? f : best), null);
  const front = head ? Math.sign(s(head)) || 1 : 1;
  const tail = central.find((f) => f.hint === 'tail') || central.find((f) => f !== head && Math.sign(s(f)) === -front && Math.abs(s(f)) > 0.35 * Math.max(W, D)) || null;
  const body = central.filter((f) => f !== head && f !== tail);
  const rootPos = body.length ? bounds(body).center : c;
  const frontPos = (() => { const p = rootPos.slice(); p[axis] += front * 0.25 * Math.max(W, D); return p; })();
  const headBase = head ? (() => { const p = head.center.slice(); p[axis] -= front * head.size[axis] * 0.5; return p; })() : frontPos;
  bones.push(boneSpec('root', 'Root', null, rootPos, frontPos, body, body.length ? 0.7 : 0.4));
  bones.push(boneSpec('neck', 'Neck', 'root', frontPos, headBase, [], head ? 0.6 : 0.3));
  if (head) bones.push(boneSpec('head', 'Head', 'neck', headBase, (() => { const p = head.center.slice(); p[axis] += front * head.size[axis] * 0.5; return p; })(), [head], head.hint === 'head' ? 0.95 : 0.6));
  if (tail) { const tailEnd = tail.center.slice(); tailEnd[axis] -= front * tail.size[axis] * 0.5; bones.push(boneSpec('tail', 'Tail', 'root', (() => { const p = rootPos.slice(); p[axis] -= front * 0.2 * Math.max(W, D); return p; })(), tailEnd, [tail], tail.hint === 'tail' ? 0.9 : 0.5)); }
  // legs: 4 columns = front/back × left/right
  const cols = new Map();
  for (const f of low) {
    const k = (s(f) * front >= 0 ? 'Front' : 'Back') + (f.center[side] > c[side] ? 'L' : 'R');
    if (!cols.has(k)) cols.set(k, []); cols.get(k).push(f);
  }
  const ik = [];
  for (const [k, objs] of cols) {
    objs.sort((a, b) => b.center[1] - a.center[1]);
    const upper = objs[0], lower = objs[1] || null, foot = objs[2] || null;
    for (const f of objs.slice(3)) unassigned.push(f.id);
    const hip = centerTop(upper), knee = lower ? centerTop(lower) : centerBottom(upper), ankle = lower ? (foot ? centerTop(foot) : centerBottom(lower)) : null;
    const name = k.replace(/(Front|Back)(L|R)/, '$1 Leg.$2');
    bones.push(boneSpec('upper' + k, `Upper ${name}`, 'root', hip, knee, [upper], 0.6));
    if (lower) bones.push(boneSpec('lower' + k, `Lower ${name}`, 'upper' + k, knee, ankle, [lower], 0.6));
    if (foot && ankle) bones.push(boneSpec('foot' + k, `Foot ${name}`, 'lower' + k, ankle, centerBottom(foot), [foot], 0.6));
    if (lower) ik.push({ boneKey: 'lower' + k, name: `${name} IK`, chainLength: 2, poleDir: axis === 0 ? [front, 0, 0] : [0, 0, front] });
  }
  if (cols.size < 4) notes.push('fewLegs');
  return { bones, unassigned, notes, ik };
}

function bird(feats, B) {
  const scale = Math.max(...B.size) || 1;
  const cx = B.center[0], H = B.size[1];
  const { pairs, paired } = findPairs(feats, cx, scale);
  const central = feats.filter((f) => !paired.has(f.id)).sort((a, b) => a.center[2] - b.center[2]);
  const wings = pairs.reduce((best, p) => (!best || Math.abs(p[0].center[0] - p[1].center[0]) > Math.abs(best[0].center[0] - best[1].center[0]) ? p : best), null);
  const legs = pairs.filter((p) => p !== wings).sort((a, b) => a[0].center[1] - b[0].center[1])[0] || null;
  const head = central.find((f) => f.hint === 'head') || central.reduce((b, f) => (!b || f.center[1] > b.center[1] ? f : b), null);
  const body = central.filter((f) => f !== head);
  const rootPos = body.length ? bounds(body).center : B.center;
  const bones = [], unassigned = [], notes = [];
  bones.push(boneSpec('root', 'Body', null, rootPos, head ? centerBottom(head) : v3.add(rootPos, [0, 0.2 * H, 0]), body, 0.6));
  if (head) bones.push(boneSpec('head', 'Head', 'root', centerBottom(head), centerTop(head), [head], head.hint === 'head' ? 0.9 : 0.5));
  if (wings) for (const [side, f] of [['L', wings[0]], ['R', wings[1]]]) { const inner = [f.center[0] - Math.sign(f.center[0] - cx) * f.size[0] * 0.5, f.center[1], f.center[2]]; const outer = [f.center[0] + Math.sign(f.center[0] - cx) * f.size[0] * 0.5, f.center[1], f.center[2]]; bones.push(boneSpec('wing' + side, `Wing.${side}`, 'root', inner, outer, [f], f.hint === 'wing' ? 0.9 : 0.6)); }
  if (legs) for (const [side, f] of [['L', legs[0]], ['R', legs[1]]]) bones.push(boneSpec('leg' + side, `Leg.${side}`, 'root', centerTop(f), centerBottom(f), [f], 0.6));
  for (const p of pairs) if (p !== wings && p !== legs) unassigned.push(p[0].id, p[1].id);
  return { bones, unassigned, notes, ik: [] };
}

function segmented(feats, B) {
  const axis = B.size.indexOf(Math.max(...B.size));
  const ordered = feats.slice().sort((a, b) => a.center[axis] - b.center[axis]);
  const bones = [];
  ordered.forEach((f, i) => {
    const next = ordered[i + 1];
    const tail = next ? next.center : (() => { const p = f.center.slice(); p[axis] += f.size[axis] * 0.5; return p; })();
    bones.push(boneSpec('seg' + (i + 1), `Segment ${i + 1}`, i ? 'seg' + i : null, f.center, tail, [f], 0.6));
  });
  return { bones, unassigned: [], notes: [], ik: [] };
}

export const TEMPLATES = { humanoid, quadruped, bird, segmented };

// ---------- standard base poses ----------
// Canonical direction of a bone in the chosen base pose (null = keep the detected one).
function canonicalDir(type, pose, key, ctx) {
  const up = [0, 1, 0], down = [0, -1, 0], fwd = ctx.forward, L = [1, 0, 0], R = [-1, 0, 0];
  const side = key.endsWith('L') ? L : key.endsWith('R') ? R : null;
  if (type === 'humanoid') {
    if (/^(hips|spine\d*|chest|neck|head)$/.test(key)) return up;
    if (/^shoulder/.test(key)) return side;
    if (/^(upperArm|forearm|hand)/.test(key)) return pose === 'apose' ? v3.norm(v3.add(side, [0, -0.7, 0])) : side;
    if (/^(thigh|shin)/.test(key)) return down;
    if (/^foot/.test(key)) return fwd;
    return null;
  }
  if (type === 'quadruped') {
    if (key === 'root') return fwd;
    if (key === 'neck') return v3.norm(v3.add(fwd, [0, 0.8, 0]));
    if (key === 'head') return fwd;
    if (key === 'tail') return v3.norm(v3.add(v3.scale(fwd, -1), [0, -0.3, 0]));
    if (/^(upper|lower)/.test(key)) return down;
    if (/^foot/.test(key)) return fwd;
    return null;
  }
  if (type === 'bird') {
    if (key === 'root') return v3.norm(v3.add(fwd, [0, 0.4, 0]));
    if (key === 'head') return up;
    if (/^wing/.test(key)) return side;
    if (/^leg/.test(key)) return down;
    return null;
  }
  if (type === 'segmented') return ctx.axisDir;
  return null;
}
// Re-pose the proposal into a standard base pose: bone heads chain from their parents
// (attachment offsets rotate with the parent), directions become canonical, lengths are
// kept, and every bone records the rigid transform (detected → standard) that
// applyRig later applies to its objects so the model follows the rig.
export function reposeProposal(proposal, pose) {
  const type = proposal.type;
  if (!pose || pose === 'detected' || !proposal.bones.length) { for (const b of proposal.bones) b.repose = null; proposal.pose = 'detected'; return proposal; }
  const bones = proposal.bones;
  const byKey = new Map(bones.map((b) => [b.key, b]));
  const detected = new Map(bones.map((b) => [b.key, { head: b.head.slice(), tail: b.tail.slice(), dir: v3.norm(v3.sub(b.tail, b.head)), len: v3.dist(b.head, b.tail) }]));
  // forward: quadruped/bird body axis from the root bone, humanoid feet (toe) direction, else -Z
  let forward = [0, 0, -1];
  const rootLike = byKey.get('root') || byKey.get('hips');
  if (type === 'quadruped' || type === 'bird') { const d = detected.get(rootLike?.key); if (d) { const h = [d.dir[0], 0, d.dir[2]]; if (v3.len(h) > 1e-6) forward = v3.norm(h); } }
  else if (type === 'humanoid') { const f = detected.get('footL') || detected.get('footR'); if (f) { const h = [f.dir[0], 0, f.dir[2]]; if (v3.len(h) > 1e-6) forward = v3.norm(h); } }
  const axisDir = detected.get(bones[0].key)?.dir || [1, 0, 0];
  const ctx = { forward, axisDir };
  const standard = new Map();
  const rot = new Map(); // key → R (detected dir → standard dir), applied to attached objects
  const done = new Set();
  const place = (b) => {
    if (done.has(b.key)) return;
    const D = detected.get(b.key);
    let head, parentR = [0, 0, 0, 1];
    if (b.parentKey && byKey.has(b.parentKey)) {
      const pb = byKey.get(b.parentKey); place(pb);
      const PS = standard.get(pb.key), PD = detected.get(pb.key);
      parentR = rot.get(pb.key);
      head = v3.add(PS.tail, quat.rotate(parentR, v3.sub(D.head, PD.tail)));
    } else head = D.head.slice();
    const canon = canonicalDir(type, pose, b.key, ctx);
    const dir = canon ? v3.norm(canon) : v3.norm(quat.rotate(parentR, D.dir));
    const R = quat.fromUnitVectors(D.dir, dir);
    standard.set(b.key, { head, tail: v3.add(head, v3.scale(dir, D.len)) });
    rot.set(b.key, R);
    done.add(b.key);
  };
  for (const b of bones) place(b);
  for (const b of bones) {
    const S = standard.get(b.key), D = detected.get(b.key);
    b.detected = { head: D.head, tail: D.tail };
    b.head = S.head; b.tail = S.tail;
    b.repose = { R: rot.get(b.key), from: D.head, to: S.head };
  }
  proposal.pose = pose;
  return proposal;
}

// ---------- proposal ----------
export function proposeRig(project, { objectIds = null, type = 'auto', ik = false, pose = null } = {}) {
  const feats = objectFeatures(project, objectIds).filter((f) => !f.parentBone || objectIds);
  if (!feats.length) return { type: 'segmented', detected: 'segmented', confidence: 0, bones: [], unassigned: [], notes: ['noObjects'], ik: [], feats: [], existingBones: project.nodes.filter((n) => n.type === 'bone').length };
  const cls = classify(feats);
  const chosen = type === 'auto' ? cls.type : type;
  const B = robustBounds(feats);
  const tpl = TEMPLATES[chosen] || TEMPLATES.segmented;
  const res = tpl(feats, B);
  // drop bones that collapsed to zero length, fix parents
  const keys = new Set(res.bones.map((b) => b.key));
  const claimed = new Set();
  const bones = res.bones.filter((b) => v3.dist(b.head, b.tail) > 1e-4).map((b) => ({ ...b, parentKey: b.parentKey && keys.has(b.parentKey) ? b.parentKey : null, objects: b.objects.filter((id) => !claimed.has(id) && claimed.add(id)) }));
  const assigned = new Set(bones.flatMap((b) => b.objects));
  const unassigned = [...new Set([...res.unassigned, ...feats.map((f) => f.id).filter((id) => !assigned.has(id))])];
  const ikList = ik ? res.ik.filter((k) => bones.some((b) => b.key === k.boneKey)) : [];
  const existingBones = project.nodes.filter((n) => n.type === 'bone').length;
  const proposal = { type: chosen, detected: cls.type, confidence: type === 'auto' ? cls.confidence : 0.95, scores: cls.scores, bones, unassigned, notes: res.notes, ik: ikList, feats, existingBones };
  return reposeProposal(proposal, pose || DEFAULT_POSE[chosen] || 'detected');
}

// Apply a (possibly user-edited) proposal to the project: creates bones (world
// head → tail orientation, Y along the bone), parents objects preserving their
// world transforms, and optionally adds IK targets / poles. Returns created ids.
export function applyRig(project, proposal, { createNode, createConstraint, reparent, setWorldTransform = null }) {
  const created = { bones: [], targets: [], poles: [], constraints: [] };
  const byKey = new Map();
  const world = new Map();
  const ordered = [];
  const pending = proposal.bones.filter((b) => !b.skip);
  // parents before children
  while (pending.length) {
    let progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const b = pending[i];
      if (!b.parentKey || byKey.has(b.parentKey)) { ordered.push(b); pending.splice(i, 1); i--; progressed = true; byKey.set(b.key, null); }
    }
    if (!progressed) { for (const b of pending) { b.parentKey = null; ordered.push(b); byKey.set(b.key, null); } break; }
  }
  for (const b of ordered) {
    const dir = v3.sub(b.tail, b.head);
    const len = Math.max(0.02, v3.len(dir));
    const rot = quat.fromUnitVectors([0, 1, 0], v3.norm(dir));
    const parentId = b.parentKey ? byKey.get(b.parentKey) : null;
    const parentW = parentId ? world.get(parentId) : xf.identity();
    const local = xf.localOf({ pos: b.head, rot }, parentW);
    const bone = createNode(project, 'bone', { name: b.name, parent: parentId, pos: local.pos, rot: local.rot, length: len });
    byKey.set(b.key, bone.id);
    world.set(bone.id, { pos: b.head.slice(), rot });
    created.bones.push(bone.id);
    for (const oid of b.objects) reparent(project, oid, bone.id);
  }
  // base pose: move each bone's objects with the rigid transform detected → standard
  if (setWorldTransform) {
    for (const b of ordered) {
      if (!b.repose || !b.objects.length) continue;
      const { R, from, to } = b.repose;
      const wt = worldTransforms(project, null);
      for (const oid of b.objects) {
        const o = getNode(project, oid), w = wt.get(oid);
        if (!o || !w) continue;
        const nw = { pos: v3.add(to, quat.rotate(R, v3.sub(w.pos, from))), rot: quat.norm(quat.mul(R, w.rot)) };
        setWorldTransform(project, o, nw, worldTransforms(project, null));
      }
    }
  }
  for (const k of proposal.ik || []) {
    const boneId = byKey.get(k.boneKey);
    const b = proposal.bones.find((x) => x.key === k.boneKey);
    if (!boneId || !b) continue;
    const target = createNode(project, 'target', { name: `${b.name} IK`, pos: b.tail.slice() });
    const con = createConstraint(project, boneId, target.id, { name: k.name, chainLength: k.chainLength });
    created.targets.push(target.id); created.constraints.push(con.id);
    if (k.poleDir) {
      const pole = createNode(project, 'pole', { name: `${b.name} Pole`, pos: v3.add(b.head, v3.scale(k.poleDir, Math.max(0.3, v3.dist(b.head, b.tail) * 2))) });
      con.poleId = pole.id; created.poles.push(pole.id);
    }
  }
  return created;
}
