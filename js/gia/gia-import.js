// .gia document → editor project (objects, decorations, existing motion
// devices as clips). The raw bytes are kept alongside the project so export
// can patch the original file instead of rebuilding it.
import { parseGia, collectObjects, collectDecorations, collectGraphs, isGiaHeaderValid } from './gia-file.js';
import { createProject, createNode } from '../scene/scene.js';
import { createClip, insertKey } from '../anim/clips.js';
import { gameToDisplayPos, gameEulerToDisplayQuat, v3, quat } from '../core/math.js';
import { MOTION_CYCLIC } from './motion-device.js';
import { CONTROLLER_NAME, GRAPH_NAME } from './node-graph.js';

export function importGia(bytes, fileName = 'model.gia') {
  const doc = parseGia(bytes);
  const project = createProject();
  project.giaName = fileName;
  const info = { objects: 0, decorations: 0, unknownModelIds: new Set(), staticObjects: 0, graphs: [], importedClips: [], controllerFound: false, headerOk: isGiaHeaderValid(doc), otherEntries: 0 };

  const objects = collectObjects(doc);
  const decorations = collectDecorations(doc);
  const graphs = collectGraphs(doc);
  info.graphs = graphs.map((g) => ({ guid: g.guid, name: g.name, nodes: g.nodeCount }));
  info.otherEntries = doc.entries.filter((e) => e.kind === 'other').length;

  const byParent = new Map();
  for (const d of decorations) {
    if (!byParent.has(d.parentGuid)) byParent.set(d.parentGuid, []);
    byParent.get(d.parentGuid).push(d);
  }
  const nodeByGuid = new Map();
  for (const o of objects) {
    const isController = o.name === CONTROLLER_NAME && o.graphBinding != null && !(byParent.get(o.guid)?.length);
    if (isController) { info.controllerFound = true; continue; }
    const tr = o.transform || { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, zoom: { x: 1, y: 1, z: 1 } };
    const decs = (byParent.get(o.guid) || []).map((d) => {
      const t = d.transform || { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
      if (d.modelId != null) info.unknownModelIds.add(d.modelId);
      return {
        guid: d.guid, name: d.name, modelId: d.modelId,
        pos: gameToDisplayPos(t.position), rot: gameEulerToDisplayQuat(t.rotation),
        scale: [t.scale.x, t.scale.y, t.scale.z], argb: d.argb,
      };
    });
    const node = createNode(project, 'object', {
      name: o.name, guid: o.guid, cls: o.cls, gameObject: o.gameObject, isStatic: o.isStatic,
      pos: gameToDisplayPos(tr.position), rot: gameEulerToDisplayQuat(tr.rotation),
      zoom: [tr.zoom.x, tr.zoom.y, tr.zoom.z], decorations: decs,
    });
    node.filePos = v3.clone(node.pos);
    node.fileRot = quat.clone(node.rot);
    node.hadMotionDevices = o.motionDevices.length > 0;
    nodeByGuid.set(o.guid, node);
    info.objects++;
    info.decorations += decs.length;
    if (o.isStatic) info.staticObjects++;
  }

  // existing motion devices → clips (positions relative to the object's
  // placement in world axes, rotations absolute)
  const clipsByName = new Map();
  for (const o of objects) {
    const node = nodeByGuid.get(o.guid);
    if (!node) continue;
    for (const dev of o.motionDevices) {
      let clip = clipsByName.get(dev.name);
      if (!clip) {
        clip = createClip(project, dev.name || 'Animation', 0);
        clip.loop = dev.motionType === MOTION_CYCLIC;
        clipsByName.set(dev.name, clip);
        info.importedClips.push(clip.name);
      }
      let t = 0;
      const restPos = node.pos, restRot = node.rot;
      insertKey(clip, node.id, 'pos', 0, restPos, 'linear');
      insertKey(clip, node.id, 'rot', 0, restRot, 'linear');
      for (const p of dev.points) {
        t += Math.max(0.03, p.duration);
        const pos = v3.add(restPos, gameToDisplayPos(p.pos));
        const rot = gameEulerToDisplayQuat(p.rot);
        insertKey(clip, node.id, 'pos', t, pos, 'linear');
        insertKey(clip, node.id, 'rot', t, rot, 'linear');
      }
      clip.duration = Math.max(clip.duration, t);
    }
  }
  if (project.clips.length) {
    project.activeClipId = project.clips[0].id;
    project.exportConfig.slots = project.clips.slice(0, 5).map((c) => ({ clipId: c.id, name: c.name, outputYaw: 0 }));
  }
  return { project, doc, info };
}
