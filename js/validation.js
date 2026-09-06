import { MAX_OBJECT_SCALE } from './gia/gia-export.js';
// Pre-export validation. Each issue: { level: 'error'|'warning'|'info', key,
// params, nodeId?, clipId? }. Errors block export; warnings mean the result
// may differ from the preview.
import { getNode, hasCycle, isAncestor } from './scene/scene.js';
import { getClip, tooCloseKeys, clipEnd, MIN_KEY_SPACING } from './anim/clips.js';
import { constraintIssues, chainBones } from './anim/ik.js';
import { MAX_DEVICES_PER_OBJECT } from './gia/motion-device.js';
import { modelInfo } from './scene/primitives.js';

export function validateProject(project, giaBytes, importInfo = null) {
  const issues = [];
  const push = (level, key, params = {}, extra = {}) => issues.push({ level, key, params, ...extra });
  const objects = project.nodes.filter((n) => n.type === 'object');

  if (!giaBytes) push('error', 'val.noFile');
  if (!objects.length) push('error', 'val.noObjects');
  for (const o of objects) {
    const z = o.zoom || [1, 1, 1];
    const axes = ['X', 'Y', 'Z'].filter((_, i) => Math.abs(z[i]) > MAX_OBJECT_SCALE + 1e-9);
    if (axes.length) push('error', 'val.objectScale', { name: o.name, guid: o.guid ?? '', axis: axes.join('/'), value: Math.max(...z.map(Math.abs)).toFixed(2), max: MAX_OBJECT_SCALE }, { nodeId: o.id });
  }
  if (hasCycle(project)) push('error', 'val.cycle');

  // parenting sanity
  for (const n of project.nodes) {
    if (n.parent && !getNode(project, n.parent)) push('warning', 'val.missingParent', { name: n.name }, { nodeId: n.id });
    if (n.parent === n.id) push('error', 'val.selfParent', { name: n.name }, { nodeId: n.id });
  }

  // bones
  for (const b of project.nodes.filter((n) => n.type === 'bone')) {
    if (!(b.length > 0)) push('warning', 'val.boneLength', { name: b.name }, { nodeId: b.id });
  }

  // IK
  for (const k of project.constraints) {
    const iss = constraintIssues(project, k);
    for (const i of iss) push(i === 'missingPole' ? 'warning' : 'error', 'val.ik.' + i, { name: k.name }, { constraintId: k.id });
    if (!iss.length && chainBones(project, k).length < (k.chainLength | 0)) push('warning', 'val.ik.shortChain', { name: k.name, n: chainBones(project, k).length }, { constraintId: k.id });
  }

  // clips
  const slots = (project.exportConfig.slots || []).filter((s) => getClip(project, s.clipId));
  if (!project.clips.length) push('error', 'val.noClips');
  else if (!slots.length) push('error', 'val.noSlots');
  if ((project.exportConfig.slots || []).length > MAX_DEVICES_PER_OBJECT) push('error', 'val.tooManySlots', { max: MAX_DEVICES_PER_OBJECT });
  const names = new Map();
  slots.forEach((s, i) => {
    const clip = getClip(project, s.clipId);
    const name = s.name || clip.name;
    if (!name.trim()) push('error', 'val.slotName', { i: i + 1 });
    if (names.has(name)) push('error', 'val.dupSlotName', { name });
    names.set(name, true);
    if (clipEnd(clip) < MIN_KEY_SPACING) push('warning', 'val.shortClip', { name: clip.name }, { clipId: clip.id });
    const tc = tooCloseKeys(clip);
    if (tc.length) push('warning', 'val.keysTooClose', { name: clip.name, n: tc.length, min: MIN_KEY_SPACING }, { clipId: clip.id });
    for (const nodeId of Object.keys(clip.tracks)) if (!getNode(project, nodeId)) push('warning', 'val.trackMissingNode', { name: clip.name }, { clipId: clip.id });
    let animatesObject = false;
    for (const nodeId of Object.keys(clip.tracks)) {
      const n = getNode(project, nodeId);
      if (!n) continue;
      if (n.type === 'object') animatesObject = true;
      else if (objects.some((o) => isAncestor(project, n.id, o.id))) animatesObject = true;
      else if (n.type === 'target' || n.type === 'pole') animatesObject = project.constraints.some((k) => k.targetId === n.id || k.poleId === n.id);
    }
    if (!animatesObject) push('warning', 'val.clipNoObjects', { name: clip.name }, { clipId: clip.id });
  });
  if (slots.length && (project.exportConfig.initialSlot | 0) >= slots.length) push('warning', 'val.initialSlot');

  // static objects are converted; game objects fine
  const staticCount = objects.filter((o) => o.isStatic).length;
  if (staticCount) push('info', 'val.staticConverted', { n: staticCount });

  // display
  const unknown = new Set();
  for (const o of objects) for (const d of o.decorations || []) if (d.modelId != null && !modelInfo(d.modelId)) unknown.add(d.modelId);
  if (unknown.size) push('info', 'val.unknownModels', { ids: [...unknown].join(', ') });
  if (importInfo?.controllerFound) push('info', 'val.controllerReplaced');
  if (importInfo && !importInfo.headerOk) push('warning', 'val.header');

  // ordering: errors first
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return issues;
}

export const hasErrors = (issues) => issues.some((i) => i.level === 'error');
