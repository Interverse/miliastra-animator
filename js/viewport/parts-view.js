// Instanced renderer for one object's display parts.
//
// Every part that shares a geometry (known model, primitive, or the unknown-model
// fallback box) is drawn by ONE InstancedMesh; outlines reuse the same instance
// matrices with a wireframe material, and selection/part highlighting is done
// with per-instance colours. Unknown parts get an adaptive representation
// (boxes / points / clustered points + bounds). A far level of detail draws
// only points and a bounding outline. Logical parts stay fully editable: the
// batching is purely a rendering concern.
import * as THREE from 'three';
import { geometryForModel, geometryForProxy, argbToRgb } from '../scene/primitives.js';
import { planGroups, unknownRepresentation, clusterStride } from './parts-plan.js';

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class PartsView {
  constructor(nodeId, makeGeometry, cachedGeometry, colors) {
    this.nodeId = nodeId;
    this.makeGeometry = makeGeometry;
    this.cachedGeometry = cachedGeometry;
    this.colors = colors;
    this.root = new THREE.Group(); // lives inside the object's inner group
    this.groups = new Map();       // key → { key, ids, mesh, outline, material, unknown }
    this.points = null;            // THREE.Points for far LOD / unknown fallback
    this.bounds = null;            // LineSegments box outline
    this.pickBox = null;           // invisible mesh so far/simplified objects stay clickable
    this.localBox = new THREE.Box3();
    this.structureKey = '';
    this.styleKey = '';
    this.partCount = 0;
  }

  // (Re)build meshes when the part structure changed (ids, kinds, models).
  build(parts) {
    const plan = planGroups(parts);
    const key = [...plan.groups.values()].map((g) => g.key + ':' + g.ids.join(',')).join('|');
    if (key === this.structureKey) return false;
    this.disposeChildren();
    this.structureKey = key;
    this.partCount = parts.length;
    this.unknownCount = plan.unknownCount;
    for (const g of plan.groups.values()) {
      const geom = g.unknown
        ? this.cachedGeometry('unknown', () => this.makeGeometry({ kind: 'box', size: [1, 1, 1] }))
        : g.kind === 'model'
          ? this.cachedGeometry('m' + g.modelId, () => this.makeGeometry(geometryForModel(g.modelId)))
          : this.cachedGeometry('px' + g.kind, () => this.makeGeometry(geometryForProxy(g.kind)));
      const material = g.unknown
        ? new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.9 })
        : new THREE.MeshLambertMaterial({ transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: true });
      const mesh = new THREE.InstancedMesh(geom, material, g.ids.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData = { nodeId: this.nodeId, group: g, parts: true };
      mesh.frustumCulled = true;
      const outline = new THREE.InstancedMesh(geom, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.9, depthTest: false }), g.ids.length);
      outline.instanceMatrix = mesh.instanceMatrix; // shared transforms
      outline.renderOrder = 15; outline.visible = false; outline.frustumCulled = true;
      outline.userData = { outline: true };
      this.root.add(mesh, outline);
      this.groups.set(g.key, { ...g, mesh, outline, material });
    }
    // points (one per part) for far LOD and the simplified unknown fallback
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(parts.length * 3), 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(parts.length * 3), 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
    this.points.renderOrder = 14; this.points.visible = false; this.points.frustumCulled = false;
    this.pointIndex = []; // part index → point slot (subset for clustered representation)
    this.root.add(this.points);
    // bounding outline + invisible pick volume
    this.bounds = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: this.colors.outline, transparent: true, opacity: 0.6, depthTest: false }));
    this.bounds.renderOrder = 15; this.bounds.visible = false; this.bounds.frustumCulled = false;
    this.pickBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
    this.pickBox.userData = { nodeId: this.nodeId, bounds: true };
    this.pickBox.visible = false;
    this.root.add(this.bounds, this.pickBox);
    return true;
  }

  // Instance matrices from the logical parts (called only when parts changed).
  updateTransforms(parts) {
    const byId = new Map(parts.map((p, i) => [p.id, i]));
    this.localBox.makeEmpty();
    const pos = this.points.geometry.attributes.position;
    let visibleCount = 0;
    for (const g of this.groups.values()) {
      g.ids.forEach((id, i) => {
        const p = parts[byId.get(id)];
        if (!p || p.hidden) { g.mesh.setMatrixAt(i, ZERO); return; }
        _p.fromArray(p.pos); _q.fromArray(p.rot); _s.fromArray(p.scale);
        _m.compose(_p, _q, _s);
        g.mesh.setMatrixAt(i, _m);
        const r = Math.max(Math.abs(p.scale[0]), Math.abs(p.scale[1]), Math.abs(p.scale[2])) * 0.87;
        this.localBox.expandByPoint(_p.clone().addScalar(-r)); this.localBox.expandByPoint(_p.clone().addScalar(r));
        visibleCount++;
      });
      g.mesh.instanceMatrix.needsUpdate = true;
      g.outline.instanceMatrix.needsUpdate = true;
      g.mesh.computeBoundingSphere(); g.outline.boundingSphere = g.mesh.boundingSphere;
    }
    // points: every visible part (unknown parts may be subsampled when clustered)
    const stride = clusterStride(this.unknownCount);
    let slot = 0; this.pointIndex = new Array(parts.length).fill(-1);
    parts.forEach((p, i) => {
      if (p.hidden) return;
      const isUnknown = p.kind === 'model' && !geometryForModel(p.modelId);
      if (isUnknown && stride > 1 && (i % stride) !== 0) return;
      pos.setXYZ(slot, p.pos[0], p.pos[1], p.pos[2]);
      this.pointIndex[i] = slot++;
    });
    pos.needsUpdate = true;
    this.points.geometry.setDrawRange(0, slot);
    this.visibleCount = visibleCount;
    // bounds outline + pick volume
    if (!this.localBox.isEmpty()) {
      const size = this.localBox.getSize(new THREE.Vector3()), center = this.localBox.getCenter(new THREE.Vector3());
      this.bounds.geometry.dispose();
      this.bounds.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x || 0.01, size.y || 0.01, size.z || 0.01));
      this.bounds.position.copy(center);
      this.pickBox.position.copy(center); this.pickBox.scale.copy(size.clone().max(new THREE.Vector3(0.01, 0.01, 0.01)));
    }
  }

  // Colours, outlines, LOD and unknown representation (called when the style key changes).
  updateStyle(parts, st) {
    const { selected, active, editing, displaySel, brightness, opacity, lod, unknownMode } = st;
    const rep = unknownRepresentation(unknownMode, this.unknownCount);
    const b = brightness ?? 1;
    const colAttr = this.points.geometry.attributes.color;
    const byId = new Map(parts.map((p, i) => [p.id, i]));
    for (const g of this.groups.values()) {
      const showMesh = lod !== 'far' && (!g.unknown || rep === 'boxes');
      g.mesh.visible = showMesh;
      g.material.opacity = g.unknown ? Math.min(0.9, opacity + 0.2) : opacity;
      g.material.depthWrite = opacity > 0.95;
      if (g.material.emissive) g.material.emissive.setScalar(Math.max(0, b - 1) * 0.18);
      // per-instance colours: base colour × brightness; unknown boxes use a muted outline tint
      g.ids.forEach((id, i) => {
        const p = parts[byId.get(id)];
        if (!p) return;
        if (g.unknown) _c.set(editing && displaySel.has(id) ? this.colors.displayEdit : 0x8a94a3);
        else if (p.kind === 'model') _c.set(argbToRgb(p.argb).hex);
        else _c.set(p.color || '#7ec8ff');
        _c.multiplyScalar(Math.min(1, b));
        if (editing && displaySel.has(id) && !g.unknown) _c.lerp(new THREE.Color(this.colors.displayEdit), 0.35);
        g.mesh.setColorAt(i, _c);
        // outline colour: selected part strong, rest of the model weak, normal selection amber
        g.outline.setColorAt(i, _c.set(editing ? (displaySel.has(id) ? this.colors.displayEdit : this.colors.displayDim) : active ? this.colors.outlineActive : this.colors.outline));
      });
      g.mesh.instanceColor.needsUpdate = true;
      g.outline.instanceColor.needsUpdate = true;
      g.outline.visible = selected && showMesh && lod === 'full';
      g.outline.material.opacity = editing ? 0.8 : 0.9;
    }
    // points: far LOD (all parts) or the simplified unknown representation
    const usePoints = lod === 'far' || (this.unknownCount > 0 && (rep === 'points' || rep === 'cluster'));
    this.points.visible = usePoints;
    if (usePoints) {
      parts.forEach((p, i) => {
        const slot = this.pointIndex[i];
        if (slot < 0) return;
        const isUnknown = p.kind === 'model' && !geometryForModel(p.modelId);
        if (lod !== 'far' && !isUnknown) { colAttr.setXYZ(slot, 0, 0, 0); return; }
        if (isUnknown) _c.set(editing && displaySel.has(p.id) ? this.colors.displayEdit : selected ? this.colors.outline : 0x8a94a3);
        else if (p.kind === 'model') _c.set(argbToRgb(p.argb).hex); else _c.set(p.color || '#7ec8ff');
        colAttr.setXYZ(slot, _c.r, _c.g, _c.b);
      });
      colAttr.needsUpdate = true;
      this.points.material.size = lod === 'far' ? 3 : rep === 'cluster' ? 3 : 4;
      // when only unknown parts are points, hide the known-part slots by zero colour + alpha trick is not
      // available per vertex; instead shrink draw range to unknown-only when possible
    }
    const showBounds = (this.unknownCount > 0 && rep !== 'boxes' && rep !== 'hidden' && lod !== 'far') || lod === 'far';
    this.bounds.visible = showBounds;
    this.bounds.material.color.set(active ? this.colors.outlineActive : selected ? this.colors.outline : 0x3f4653);
    this.bounds.material.opacity = selected ? 0.9 : 0.45;
    // the pick volume stands in for parts that are not drawn as meshes
    this.pickBox.visible = lod === 'far' || (this.unknownCount > 0 && rep !== 'boxes');
  }

  pickables() {
    const out = [];
    for (const g of this.groups.values()) if (g.mesh.visible) out.push(g.mesh);
    if (this.pickBox?.visible) out.push(this.pickBox);
    return out;
  }
  disposeChildren() {
    for (const g of this.groups.values()) { g.mesh.dispose(); g.material.dispose(); g.outline.material.dispose(); }
    this.groups.clear();
    if (this.points) { this.points.geometry.dispose(); this.points.material.dispose(); }
    if (this.bounds) { this.bounds.geometry.dispose(); this.bounds.material.dispose(); }
    if (this.pickBox) { this.pickBox.geometry.dispose(); this.pickBox.material.dispose(); }
    while (this.root.children.length) this.root.remove(this.root.children[0]);
    this.points = this.bounds = this.pickBox = null;
  }
  dispose() { this.disposeChildren(); }
}
