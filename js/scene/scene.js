// Editor scene model: a flat list of nodes with parent links. Node kinds:
//   object  – an imported .gia object (rigid group of decorations)
//   bone    – rigging bone (head at its origin, tail along local +Y × length)
//   proxy   – display-only primitive (never exported)
//   target  – IK target empty
//   pole    – IK pole empty
// Transforms are local {pos, rot(quat)} in display space. Children inherit
// position and rotation but NOT scale: an object's zoom only scales its own
// decorations, so proxies and child objects keep their real-world size.
import { v3, quat, xf } from '../core/math.js';

export const NODE_TYPES = ['object', 'bone', 'proxy', 'target', 'pole'];

export function newId(project, prefix = 'n') {
  project.counter = (project.counter || 0) + 1;
  return `${prefix}${project.counter}`;
}

export function createProject() {
  return {
    version: 1,
    counter: 0,
    giaName: null,
    nodes: [],
    constraints: [],
    clips: [],
    activeClipId: null,
    waypaths: [],
    activeWaypathId: null,
    settings: {
      proxyOpacity: 0.35,
      globalOffset: [0, 0, 0],
      autoKey: true,
      fps: 30,
      relativeFrame: 'world',
      showBones: true,
      showAxes: true,
      showPivots: true,
      showDecorations: true,
      showProxies: true,
      showWaypaths: true,
      showConstraints: true,
      showGrid: true,
    },
    exportConfig: { slots: [], initialSlot: 0, switching: true, precision: 'normal' },
  };
}

export function createNode(project, type, props = {}) {
  const node = {
    id: newId(project),
    type,
    name: props.name || defaultName(project, type),
    parent: props.parent ?? null,
    pos: props.pos ? v3.clone(props.pos) : [0, 0, 0],
    rot: props.rot ? quat.clone(props.rot) : [0, 0, 0, 1],
    hidden: false,
  };
  if (type === 'object') {
    Object.assign(node, {
      guid: props.guid ?? null,
      cls: props.cls ?? 3,
      zoom: props.zoom ? v3.clone(props.zoom) : [1, 1, 1],
      filePos: v3.clone(node.pos),
      fileRot: quat.clone(node.rot),
      correction: [0, 0, 0],
      decorations: props.decorations || [],
      isStatic: !!props.isStatic,
      gameObject: !!props.gameObject,
    });
  } else if (type === 'bone') {
    node.length = props.length ?? 0.25;
  } else if (type === 'proxy') {
    node.shape = props.shape || 'cuboid';
    node.size = props.size ? v3.clone(props.size) : [0.2, 0.2, 0.2];
    node.color = props.color || '#7ec8ff';
  }
  project.nodes.push(node);
  return node;
}

export function defaultName(project, type) {
  const base = { object: 'Object', bone: 'Bone', proxy: 'Proxy', target: 'IK Target', pole: 'Pole Target' }[type] || 'Node';
  let n = 1;
  const names = new Set(project.nodes.map((x) => x.name));
  while (names.has(`${base}${n > 1 ? '.' + String(n).padStart(3, '0') : ''}`)) n++;
  return `${base}${n > 1 ? '.' + String(n).padStart(3, '0') : ''}`;
}

export const getNode = (project, id) => project.nodes.find((n) => n.id === id) || null;
export const childrenOf = (project, id) => project.nodes.filter((n) => n.parent === id);
export const rootNodes = (project) => project.nodes.filter((n) => !n.parent || !getNode(project, n.parent));

export function isAncestor(project, ancestorId, nodeId) {
  let cur = getNode(project, nodeId);
  let guard = 0;
  while (cur && cur.parent && guard++ < 1000) {
    if (cur.parent === ancestorId) return true;
    cur = getNode(project, cur.parent);
  }
  return false;
}

export function descendants(project, id) {
  const out = [];
  const walk = (pid) => { for (const c of childrenOf(project, pid)) { out.push(c); walk(c.id); } };
  walk(id);
  return out;
}

export function depthOf(project, id) {
  let d = 0, cur = getNode(project, id);
  while (cur && cur.parent && d < 1000) { d++; cur = getNode(project, cur.parent); }
  return d;
}

// Effective local transform: base pose (or override) with the object's
// corrective rotation applied in its own frame, then the node's frozen basis
// (Freeze Transform): position = basis.pos + editable pos (parent frame),
// rotation = basis.rot ∘ editable rot. The two parts are independent, so
// freezing the rotation leaves the position values untouched and vice versa.
export function localTransform(node, pose) {
  const pos = pose?.pos || node.pos;
  let rot = pose?.rot || node.rot;
  if (node.type === 'object' && node.correction && (node.correction[0] || node.correction[1] || node.correction[2])) {
    rot = quat.mul(rot, quat.fromEulerDeg(node.correction));
  }
  if (node.basis) return { pos: v3.add(node.basis.pos, pos), rot: quat.norm(quat.mul(node.basis.rot, rot)) };
  return { pos, rot };
}

// World transforms for all nodes. `poses` (Map id → {pos?, rot?}) overrides
// base transforms; the global offset is applied to root nodes.
export function worldTransforms(project, poses = null) {
  const world = new Map();
  const byId = new Map(project.nodes.map((n) => [n.id, n]));
  const off = project.settings?.globalOffset || [0, 0, 0];
  const resolve = (node, guard = 0) => {
    if (world.has(node.id)) return world.get(node.id);
    const local = localTransform(node, poses?.get(node.id));
    let w;
    const parent = node.parent ? byId.get(node.parent) : null;
    if (parent && guard < 1000) w = xf.compose(resolve(parent, guard + 1), local);
    else w = { pos: v3.add(local.pos, off), rot: quat.clone(local.rot) };
    world.set(node.id, w);
    return w;
  };
  for (const n of project.nodes) resolve(n);
  return world;
}

export function parentWorld(project, parentId, world) {
  if (!parentId) {
    const off = project.settings?.globalOffset || [0, 0, 0];
    return { pos: v3.clone(off), rot: [0, 0, 0, 1] };
  }
  return world.get(parentId) || xf.identity();
}

// Editable local values (what the Properties panel shows and keys store) from an
// effective local transform: undo the frozen basis, then the correction.
export function editableLocal(node, eff) {
  let { pos, rot } = eff;
  if (node.basis) { pos = v3.sub(pos, node.basis.pos); rot = quat.mul(quat.conj(node.basis.rot), rot); }
  if (node.type === 'object' && node.correction && (node.correction[0] || node.correction[1] || node.correction[2])) {
    rot = quat.mul(rot, quat.conj(quat.fromEulerDeg(node.correction)));
  }
  return { pos: v3.clone(pos), rot: quat.norm(rot) };
}
export function editableLocalFromWorld(project, node, worldT, world) {
  return editableLocal(node, xf.localOf(worldT, parentWorld(project, node.parent, world)));
}
// Set a node's base transform from a desired world transform (keeps the
// correction and the frozen basis).
export function setWorldTransform(project, node, worldT, world = worldTransforms(project)) {
  const local = editableLocalFromWorld(project, node, worldT, world);
  node.pos = local.pos;
  node.rot = local.rot;
}

// Re-parent while preserving the world transform of the node.
export function reparent(project, nodeId, newParentId) {
  const node = getNode(project, nodeId);
  if (!node) return false;
  if (newParentId === nodeId || (newParentId && isAncestor(project, nodeId, newParentId))) return false;
  const world = worldTransforms(project);
  const w = world.get(nodeId);
  node.parent = newParentId || null;
  setWorldTransform(project, node, w, world);
  // move the node right after its new parent's last descendant for a tidy outliner
  project.nodes = project.nodes.filter((n) => n !== node);
  const sub = descendants(project, nodeId);
  const subSet = new Set(sub.map((n) => n.id));
  const rest = project.nodes.filter((n) => !subSet.has(n.id));
  let idx = rest.length;
  if (node.parent) {
    const pIdx = rest.findIndex((n) => n.id === node.parent);
    idx = pIdx + 1;
    while (idx < rest.length && isAncestor(project, node.parent, rest[idx].id)) idx++;
  }
  rest.splice(idx, 0, node, ...sub);
  project.nodes = rest;
  return true;
}

// Delete a node; children are re-parented to its parent (world preserved).
export function deleteNode(project, nodeId) {
  const node = getNode(project, nodeId);
  if (!node) return;
  const world = worldTransforms(project);
  for (const c of childrenOf(project, nodeId)) {
    c.parent = node.parent;
    setWorldTransform(project, c, world.get(c.id), world);
  }
  project.nodes = project.nodes.filter((n) => n.id !== nodeId);
  project.constraints = project.constraints.filter((k) => k.boneId !== nodeId && k.targetId !== nodeId && k.poleId !== nodeId);
  for (const k of project.constraints) if (k.poleId === nodeId) k.poleId = null;
  for (const clip of project.clips) delete clip.tracks[nodeId];
  for (const wp of project.waypaths) if (wp.targetId === nodeId) wp.targetId = null;
}

export function boneTail(node, world) {
  const w = world.get(node.id);
  return v3.add(w.pos, quat.rotate(w.rot, [0, node.length || 0.25, 0]));
}

// Sorted (depth-first) node list for the outliner.
export function orderedNodes(project) {
  const out = [];
  const walk = (pid, depth) => {
    for (const n of project.nodes) {
      if ((n.parent || null) === pid) { out.push({ node: n, depth }); walk(n.id, depth + 1); }
    }
  };
  walk(null, 0);
  // orphans (parent missing)
  const seen = new Set(out.map((o) => o.node.id));
  for (const n of project.nodes) if (!seen.has(n.id)) out.push({ node: n, depth: 0 });
  return out;
}

export function hasCycle(project) {
  for (const n of project.nodes) {
    let cur = n, guard = 0;
    while (cur && cur.parent && guard++ < project.nodes.length + 1) cur = getNode(project, cur.parent);
    if (guard > project.nodes.length) return true;
  }
  return false;
}
