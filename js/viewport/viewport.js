// Three.js viewport: renders the scene model (objects with automatic display
// geometry, proxies, bones, IK targets/poles, waypaths), handles picking,
// selection outlines and the move/rotate gizmo.
import * as THREE from 'three';
import { t } from '../i18n/i18n.js';
import { displayOf, isPositionOnly } from '../ui/editor.js';
import { displayParts } from '../scene/display-parts.js';
import { PartsView } from './parts-view.js';
import { pixelRadius, lodLevel, partIdForInstance } from './parts-plan.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CameraController } from './camera.js';
import { createNavGizmo, VIEW_DIRS } from './nav-gizmo.js';
import { geometryForModel, geometryForProxy, argbToRgb } from '../scene/primitives.js';
import { getNode, boneTail } from '../scene/scene.js';
import { chainBones } from '../anim/ik.js';
import { v3, quat, xf } from '../core/math.js';
import { effectiveDirectional } from '../anim/waypath.js';
import { EntityRegistry, viewportEntities, validateSceneModel } from './scene-model.js';

const COLORS = {
  bone: 0xb18cff, boneSel: 0xff9f43, boneActive: 0xffd166, boneIK: 0x5fd3c9,
  target: 0xff9f43, pole: 0xf0b429, outline: 0xff9f43, outlineActive: 0xffd166, proxy: 0x7ec8ff,
  path: 0x36d47e, pathPoint: 0x8ee0a1, pathPointSel: 0xffd166, constraint: 0xff9f43, poleLine: 0xf0b429, pivot: 0xffffff,
  displayEdit: 0x22d3ee, displayDim: 0x0e7490, rigPreview: 0x36d47e,
};

function makeGeometry(desc) {
  switch (desc.kind) {
    case 'box': return new THREE.BoxGeometry(desc.size[0], desc.size[1], desc.size[2]);
    case 'sphere': return new THREE.SphereGeometry(0.5, 20, 14);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
    case 'cone': return new THREE.ConeGeometry(0.5, 1, 20);
    case 'mesh': {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(desc.positions, 3));
      g.setIndex(desc.indices);
      g.computeVertexNormals();
      return g;
    }
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

// Blender-style octahedral bone, unit length along +Y
function boneGeometry() {
  const r = 0.07, y = 0.12;
  const verts = [[0, 0, 0], [r, y, r], [-r, y, r], [-r, y, -r], [r, y, -r], [0, 1, 0]];
  const idx = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts.flat(), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const geomCache = new Map();
function cachedGeometry(key, make) {
  if (!geomCache.has(key)) geomCache.set(key, make());
  return geomCache.get(key);
}

export class Viewport {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;
    this.canvas = container.querySelector('#canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x14161a);
    this.scene = new THREE.Scene();
    this.cam = new CameraController(this.canvas, {
      wasd: editor.wasd, onChange: () => this.nav?.draw(),
      onDragStart: (mode, pointerId) => editor.beginInteraction('viewport-' + mode, { finish: () => this.cam.cancelDrag(), pointerId }),
      onDragEnd: (mode) => editor.endInteraction('viewport-' + mode),
    });
    // Scene layout: env (survives projects) · projectRoot (replaced wholesale on every
    // project switch) · overlay (editor-only visuals, cleared with their owning state).
    this.env = new THREE.Group(); this.env.name = 'env';
    this.scene.add(this.env);
    this.hemi = new THREE.HemisphereLight(0xdde6f5, 0x1a1c22, 1.1);
    this.env.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(3, 6, 4);
    this.env.add(this.sun);
    this.grid = new THREE.GridHelper(20, 20, 0x3a4150, 0x262a32);
    this.grid.position.y = -0.0005;
    this.env.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.env.add(this.axes);
    this.projectRoot = new THREE.Group(); this.projectRoot.name = 'projectRoot';
    this.scene.add(this.projectRoot);
    this.nodeRoot = new THREE.Group(); this.nodeRoot.name = 'nodes';
    this.projectRoot.add(this.nodeRoot);
    this.overlay = new THREE.Group(); this.overlay.name = 'overlay';
    this.scene.add(this.overlay);
    // every rendered node lives in the registry under its state id (see scene-model.js)
    this.registry = new EntityRegistry();
    this._tmpColor = new THREE.Color();
    this._tmpSphere = new THREE.Sphere();
    this._tmpV = new THREE.Vector3();
    this.pickDirty = true;
    this.pickables = [];
    this.nav = createNavGizmo(this.cam, () => {});
    this.setupGizmo();
    this.setupRotateGizmo();
    this.setupPointer();
    this.setupOverlayObjects();
    this.pathVisual = { sig: null, group: new THREE.Group(), points: [] };
    this.pathVisual.group.name = 'waypaths';
    this.projectRoot.add(this.pathVisual.group);
    // a project switch tears the whole project root down before the new state is shown
    this.editor.on('project', (e) => { if (e?.phase === 'teardown') this.resetProject(); });
    // development diagnostics after history / project changes (opt-in: localStorage.debugViewport = '1')
    this.editor.on('change', (e) => { if (this.debug && e && /^(undo|new|open|import|cancel)$/.test(e.label || '')) this.validate({ warn: true, afterSync: true }); });
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.keys = new Set();
    this.clock = performance.now();
    this.editor.on('tool', () => this.syncTool());
    this.editor.on('view', () => this.syncTool());
    // selection changes never inherit stale hover/active handles from the previous node
    this.editor.on('selection', () => { this.setRingHover(null); if (this.tc.axis && !this.tc.dragging) this.tc.axis = null; });
    this.syncTool();
    requestAnimationFrame(() => this.loop());
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.cam.resize(w, h);
  }

  // ---------- gizmo ----------
  setupGizmo() {
    this.handle = new THREE.Object3D(); this.handle.name = 'gizmoHandle';
    this.overlay.add(this.handle);
    const tc = new TransformControls(this.cam.camera, this.canvas);
    tc.size = 0.85;
    this.tc = tc;
    const helper = tc.getHelper ? tc.getHelper() : tc;
    this.overlay.add(helper);
    this.tcHelper = helper;
    tc.attach(this.handle);
    tc.enabled = false;
    helper.visible = false;
    tc.addEventListener('dragging-changed', (e) => {
      this.cam.enabled = !e.value;
      if (e.value) this.beginDrag(); else this.endDrag();
    });
    tc.addEventListener('objectChange', () => this.onGizmoChange());
  }
  syncTool() {
    const ed = this.editor;
    this.cam.wasd = ed.wasd;
    this.cam.reversePanX = !!ed.view.reversePanX;
    this.cam.reversePanY = !!ed.view.reversePanY;
    this.cam.reverseOrbitX = !!ed.view.reverseOrbitX;
    this.cam.reverseOrbitY = !!ed.view.reverseOrbitY;
    // TransformControls only handles translation; rotation uses the ring gizmo below
    this.tc.setMode('translate');
    this.tc.setSpace(ed.space);
    this.tc.setTranslationSnap(ed.snap.enabled ? ed.snap.pos : null);
    this.applyView();
  }
  // Viewport brightness shades the DISPLAY GEOMETRY only (model decorations,
  // proxies): below 1 the base colour is darkened, above 1 a self-illumination
  // term is added so shapes read clearly without washing out. Background, grid,
  // axes, gizmos, bones, outlines and opacity are untouched. Editor-only pref.
  applyView() {
    this.brightness = THREE.MathUtils.clamp(this.editor.view.brightness ?? 1, 0.3, 2.2);
  }
  shade(mat, base) {
    const b = this.brightness ?? 1;
    mat.color.copy(base).multiplyScalar(Math.min(1, b));
    if (mat.emissive) mat.emissive.copy(base).multiplyScalar(Math.max(0, b - 1) * 0.55);
  }

  // ---------- rotation gizmo (screen-angle rings, Blender-style) ----------
  setupRotateGizmo() {
    this.rg = new THREE.Group(); this.rg.name = 'rotateGizmo';
    this.rg.visible = false;
    this.overlay.add(this.rg);
    this.rgRings = [];
    this.rgPicks = [];
    const defs = [
      { axis: 'x', color: 0xe5534b, rot: [0, Math.PI / 2, 0] },
      { axis: 'y', color: 0x57ab5a, rot: [Math.PI / 2, 0, 0] },
      { axis: 'z', color: 0x539bf5, rot: [0, 0, 0] },
    ];
    for (const d of defs) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.014, 8, 72), new THREE.MeshBasicMaterial({ color: d.color, depthTest: false, transparent: true, opacity: 0.85 }));
      ring.rotation.set(...d.rot);
      ring.renderOrder = 30;
      ring.userData.axis = d.axis; ring.userData.baseColor = d.color;
      const pick = new THREE.Mesh(new THREE.TorusGeometry(1, 0.07, 6, 48), new THREE.MeshBasicMaterial({ visible: false }));
      pick.rotation.set(...d.rot);
      pick.userData.axis = d.axis;
      this.rg.add(ring, pick);
      this.rgRings.push(ring);
      this.rgPicks.push(pick);
    }
    // faint sphere to show the ball the rings belong to
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.98, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.04, depthTest: false }));
    ball.renderOrder = 29;
    this.rg.add(ball);
    this.rotDrag = null;
    this.rgHover = null;
  }
  gizmoRadius(center) {
    const cam = this.cam;
    const dist = cam.projection === 'persp' ? cam.camera.position.distanceTo(new THREE.Vector3(...center)) : cam.distance;
    return Math.max(0.02, dist * Math.tan(THREE.MathUtils.degToRad(cam.persp.fov / 2)) * 0.19);
  }
  screenPoint(worldPos) {
    const v = new THREE.Vector3(...worldPos).project(this.cam.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height };
  }
  hitRing(x, y) {
    if (!this.rg.visible) return null;
    const rc = this.cam.ray(x, y);
    const hits = rc.intersectObjects(this.rgPicks, false);
    return hits.length ? hits[0].object.userData.axis : null;
  }
  setRingHover(axis) {
    if (this.rgHover === axis) return;
    this.rgHover = axis;
    for (const r of this.rgRings) {
      const on = r.userData.axis === axis;
      r.material.color.set(on ? 0xffd166 : r.userData.baseColor);
      r.material.opacity = on ? 1 : 0.85;
      r.scale.setScalar(on ? 1.04 : 1);
    }
  }
  beginRotateDrag(axis, e) {
    const ed = this.editor;
    if (!this.gizmoTarget()?.node) return false;
    // own the pointer first (finishes anything stale, pauses playback), then sample the pose
    ed.beginInteraction('gizmo-rotate', { finish: () => this.endRotateDrag(), cancel: () => this.cancelRotateDrag(), pointerId: e.pointerId });
    const tgt = this.gizmoTarget();
    if (!tgt || (tgt.kind !== 'node' && tgt.kind !== 'display' && tgt.kind !== 'parts')) { ed.endInteraction('gizmo-rotate'); return false; }
    const driver = tgt.kind === 'node' ? ed.constraintDriving(tgt.node.id) : null;
    if (driver) ed.setHint(t('hint.ikDriven', { name: driver.name }));
    const unit = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis];
    const axisWorld = ed.space === 'local' ? v3.norm(quat.rotate(tgt.rot, unit)) : unit;
    const center = this.screenPoint(tgt.pos);
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // sign: positive screen angle (counter-clockwise) = positive rotation when the axis points at the camera
    const toCam = this.cam.projection === 'persp'
      ? v3.sub(this.cam.camera.position.toArray(), tgt.pos)
      : v3.neg(this.cam.camera.getWorldDirection(new THREE.Vector3()).toArray());
    const sign = v3.dot(axisWorld, toCam) >= 0 ? 1 : -1;
    const angle = Math.atan2(-(py - center.y), px - center.x);
    const starts = new Map();
    if (tgt.kind === 'display') starts.set(tgt.node.id, xf.clone(ed.displayFrameWorld(tgt.node.id)));
    else if (tgt.kind === 'parts') for (const pid of tgt.ids) starts.set(pid, xf.clone(ed.partWorld(tgt.node.id, pid)));
    else { const dw = ed.displayWorld(); for (const id of ed.selection) { const w = dw.get(id); if (w) starts.set(id, xf.clone(w)); } }
    this.rotDrag = { axis, axisWorld, sign, center, lastAngle: angle, total: 0, starts, pivot: v3.clone(tgt.pos), pointerId: e.pointerId, applied: 0, kind: tgt.kind, nodeId: tgt.node?.id, preserve: ed.rotateMode === 'preserve' && tgt.kind === 'node' };
    if (this.rotDrag.preserve) ed.beginReorient([...starts.keys()]);
    this.setRingHover(axis);
    this.cam.enabled = false;
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    return true;
  }
  updateRotateDrag(e) {
    const d = this.rotDrag;
    const ed = this.editor;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const angle = Math.atan2(-(py - d.center.y), px - d.center.x);
    let diff = angle - d.lastAngle;
    if (diff > Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    d.lastAngle = angle;
    d.total += diff;
    let applied = d.total * d.sign;
    if (ed.snap.enabled) { const step = THREE.MathUtils.degToRad(ed.snap.rot); applied = Math.round(applied / step) * step; }
    d.applied = applied;
    const dRot = quat.axisAngle(d.axisWorld, applied);
    if (d.kind === 'display') {
      // display-model rotation: turn the display frame about its own pivot
      for (const [id, w0] of d.starts) ed.setDisplayWorld(id, { pos: w0.pos, rot: quat.norm(quat.mul(dRot, w0.rot)) }, { commit: false });
      ed.setHint(`${d.axis.toUpperCase()}: ${(applied * 180 / Math.PI).toFixed(1)}° · ${t('display.editing')}`);
      return;
    }
    if (d.kind === 'parts') {
      // selected parts turn as a group about the selection centre
      for (const [pid, w0] of d.starts) ed.setPartWorld(d.nodeId, pid, { pos: v3.add(d.pivot, quat.rotate(dRot, v3.sub(w0.pos, d.pivot))), rot: quat.norm(quat.mul(dRot, w0.rot)) }, { commit: false });
      ed.setHint(`${d.axis.toUpperCase()}: ${(applied * 180 / Math.PI).toFixed(1)}° · ${t('display.editing')}`);
      return;
    }
    const off = ed.displayOffset();
    const ids = [...d.starts.keys()].filter((id) => ![...d.starts.keys()].some((o) => o !== id && isAncestorOf(ed.project, o, id)));
    for (const id of ids) {
      const w0 = d.starts.get(id);
      // Keep-children mode reorients each node in place (no orbit around the pivot)
      const pos = d.preserve ? w0.pos : v3.add(d.pivot, quat.rotate(dRot, v3.sub(w0.pos, d.pivot)));
      const nw = { pos, rot: quat.norm(quat.mul(dRot, w0.rot)) };
      ed.setNodeWorld(id, ed.removePathOffset(nw, off), { commit: false });
    }
    ed.setHint(`${d.axis.toUpperCase()}: ${(applied * 180 / Math.PI).toFixed(1)}°`);
  }
  // Normal end (pointerup) and `finish` of the interaction: keep what was applied.
  endRotateDrag() {
    const d = this.rotDrag;
    this.rotDrag = null;
    this.cam.enabled = true;
    if (!d) return;
    const ed = this.editor;
    this.releaseCapture(d.pointerId);
    if (d.preserve) { if (Math.abs(d.applied) > 1e-9) ed.endReorient(); else { ed._reorient = null; ed.transient(); } }
    else if (Math.abs(d.applied) > 1e-9) ed.commit(d.kind === 'display' ? t('hist.display') : d.kind === 'parts' ? t('hist.displayPart') : 'rotate');
    else ed.transient();
    const ids = [...d.starts.keys()];
    ed.setHint(ids.some((id) => ed.hasPoseOverride(id)) ? t('hint.unkeyedPose') : '');
    ed.endInteraction('gizmo-rotate');
  }
  // Escape / cancel: restore the drag-start pose exactly (last committed state).
  cancelRotateDrag() {
    const d = this.rotDrag;
    this.rotDrag = null;
    this.cam.enabled = true;
    if (!d) return;
    this.releaseCapture(d.pointerId);
    this.editor._reorient = null;
    this.editor.restoreCommitted();
    this.editor.setHint(t('hint.cancelled'));
  }
  releaseCapture(id) { try { if (id != null && this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id); } catch {} }
  // Central cleanup for the Move gizmo (TransformControls): works whether or not
  // the library still believes it is dragging (it ignores pointerup while disabled).
  settleMove(cancel = false) {
    if (this.drag) this.drag.cancelled = cancel;
    if (this.tc.dragging) this.tc.pointerUp(null); // → dragging-changed(false) → endDrag()
    else this.endDrag();
    this.tc.axis = null;
    this.releaseCapture(this._pointerId);
    this.cam.enabled = true;
  }
  gizmoTarget() {
    const ed = this.editor;
    if (ed.tool === 'select') return null;
    if (ed.pathPointSel) {
      const wp = ed.project.waypaths.find((w) => w.id === ed.pathPointSel.wpId);
      const p = wp?.points[ed.pathPointSel.index];
      if (p && ed.tool === 'move') return { kind: 'path', wp, index: ed.pathPointSel.index, pos: p, rot: [0, 0, 0, 1] };
      return null;
    }
    const node = ed.activeNode();
    if (!node) return null;
    if (ed.displayEdit) {
      // Edit Display Model: selected parts (median pivot, active part's axes) or,
      // with nothing selected, the display-model root offset
      if (node.type !== 'object') return null;
      const parts = ed.selectedDisplayParts();
      if (parts.length) {
        const worlds = parts.map((p) => ({ id: p.id, w: ed.partWorld(node.id, p.id) })).filter((x) => x.w);
        if (!worlds.length) return null;
        let c = [0, 0, 0];
        for (const x of worlds) c = v3.add(c, x.w.pos);
        c = v3.scale(c, 1 / worlds.length);
        const active = worlds.find((x) => x.id === ed.displayActive) || worlds[worlds.length - 1];
        return { kind: 'parts', node, ids: worlds.map((x) => x.id), pos: c, rot: active.w.rot };
      }
      const f = ed.displayFrameWorld(node.id);
      return f ? { kind: 'display', node, pos: f.pos, rot: f.rot } : null;
    }
    if (ed.tool === 'scale') return null;
    if (ed.tool === 'rotate' && isPositionOnly(node)) return null; // position-only rig control
    const w = ed.displayWorld().get(node.id);
    return w ? { kind: 'node', node, pos: w.pos, rot: w.rot } : null;
  }
  beginDrag() {
    const ed = this.editor;
    // a stale record means a pointerup was missed: settle it without touching TransformControls
    if (this.drag) this.endDrag(); else ed.endInteraction('gizmo-move');
    const tgt = this.gizmoTarget();
    if (!tgt) return;
    ed.beginInteraction('gizmo-move', { finish: () => this.settleMove(false), cancel: () => this.settleMove(true), pointerId: this._pointerId });
    this.drag = { tgt, startHandle: { pos: this.handle.position.toArray(), rot: this.handle.quaternion.toArray() }, starts: new Map() };
    if (tgt.kind === 'display') this.drag.startScale = displayOf(tgt.node).scale.slice();
    if (tgt.kind === 'parts') {
      this.drag.pivot = v3.clone(tgt.pos);
      this.drag.partStarts = new Map(tgt.ids.map((pid) => [pid, { world: xf.clone(ed.partWorld(tgt.node.id, pid)), scale: ed.displayPart(tgt.node.id, pid).scale.slice() }]));
    }
    if (tgt.kind === 'node') {
      const dw = ed.displayWorld();
      for (const id of ed.selection) { const w = dw.get(id); if (w) this.drag.starts.set(id, xf.clone(w)); }
      // Preserve child world transforms: one exact delta from the drag-start snapshot, descendants rebased
      if (ed.rotateMode === 'preserve' && this.drag.starts.size) {
        this.drag.preserve = true;
        ed.beginReorient([...this.drag.starts.keys()]);
        if (ed.tool === 'move' && [...this.drag.starts.keys()].some((id) => ed.moveRebaseInexact(id))) ed.setHint(t('props.rotModeMoveWarn'));
      }
    }
  }
  onGizmoChange() {
    const d = this.drag;
    if (!d) return;
    const ed = this.editor;
    const hp = this.handle.position.toArray(), hr = this.handle.quaternion.toArray();
    if (d.tgt.kind === 'path') { ed.setPathPoint(d.tgt.wp.id, d.tgt.index, hp, false); return; }
    if (d.tgt.kind === 'display') {
      if (ed.tool === 'scale') { const s = this.handle.scale.toArray(); ed.setDisplayTransform(d.tgt.node.id, { scale: v3.mul(d.startScale, s) }, { commit: false }); }
      else ed.setDisplayWorld(d.tgt.node.id, { pos: hp, rot: hr }, { commit: false });
      return;
    }
    if (d.tgt.kind === 'parts') {
      const nid = d.tgt.node.id;
      if (ed.tool === 'scale') {
        // group scale about the selection centre in the gizmo's axes; each part's own scale scales too
        const s = this.handle.scale.toArray();
        const R = d.startHandle.rot, Rinv = quat.conj(R);
        for (const [pid, st] of d.partStarts) {
          const rel = quat.rotate(Rinv, v3.sub(st.world.pos, d.pivot));
          const pos = v3.add(d.pivot, quat.rotate(R, v3.mul(rel, s)));
          ed.setPartWorld(nid, pid, { pos, rot: st.world.rot }, { commit: false });
          ed.setPartTransform(nid, pid, { scale: v3.mul(st.scale, s) }, { commit: false });
        }
      } else {
        const dPos = v3.sub(hp, d.startHandle.pos);
        for (const [pid, st] of d.partStarts) ed.setPartWorld(nid, pid, { pos: v3.add(st.world.pos, dPos), rot: st.world.rot }, { commit: false });
      }
      return;
    }
    // delta relative to the start handle transform
    const s = d.startHandle;
    const dPos = v3.sub(hp, s.pos);
    const dRot = quat.mul(hr, quat.conj(s.rot));
    const off = ed.displayOffset();
    // only move descendants once: skip nodes whose ancestor is also selected
    const ids = [...d.starts.keys()].filter((id) => ![...d.starts.keys()].some((o) => o !== id && isAncestorOf(ed.project, o, id)));
    for (const id of ids) {
      const w0 = d.starts.get(id);
      let nw;
      if (ed.tool === 'rotate') {
        const rel = v3.sub(w0.pos, s.pos);
        // preserve mode reorients in place (no orbit about the pivot)
        nw = { pos: d.preserve ? w0.pos : v3.add(s.pos, quat.rotate(dRot, rel)), rot: quat.norm(quat.mul(dRot, w0.rot)) };
      } else nw = { pos: v3.add(w0.pos, dPos), rot: w0.rot };
      ed.setNodeWorld(id, ed.removePathOffset(nw, off), { commit: false });
    }
  }
  endDrag() {
    const d = this.drag;
    this.drag = null;
    this.cam.enabled = true;
    if (!d) return;
    const ed = this.editor;
    if (d.cancelled) { ed._reorient = null; ed.restoreCommitted(); ed.setHint(t('hint.cancelled')); }
    else if (d.preserve) { if (ed._reorient?.moved.size) ed.endReorient(); else { ed._reorient = null; ed.transient(); } }
    else if (d.tgt.kind === 'path') ed.commit('path');
    else if (d.tgt.kind === 'display') ed.commit(t('hist.display'));
    else if (d.tgt.kind === 'parts') ed.commit(t('hist.displayPart'));
    else ed.commit('move');
    ed.endInteraction('gizmo-move');
  }

  // ---------- pointer picking ----------
  setupPointer() {
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      this._pointerId = e.pointerId;
      if (e.button !== 0 || e.altKey) return;
      this.canvas.focus();
      if (this.editor.tool === 'rotate' && !this.rotDrag) {
        const axis = this.hitRing(e.clientX, e.clientY);
        if (axis && this.beginRotateDrag(axis, e)) { down = null; e.preventDefault(); return; }
      }
      // remember whether this press landed on the Move gizmo so releasing it never re-picks
      down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, onGizmo: !!(this.tc.enabled && (this.tc.axis || this.tc.dragging)) };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.rotDrag) {
        if (e.pointerId === this.rotDrag.pointerId) this.updateRotateDrag(e);
        else if (!e.buttons) this.editor.finishInteraction(); // stale drag from a lost pointer
        return;
      }
      if (this.editor.tool === 'rotate' && !this.cam.isDragging() && !e.buttons) this.setRingHover(this.hitRing(e.clientX, e.clientY));
    });
    const lost = () => { if (this.rotDrag || this.drag || this.tc.dragging) this.editor.finishInteraction(); };
    this.canvas.addEventListener('pointercancel', lost);
    this.canvas.addEventListener('lostpointercapture', lost);
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.rotDrag) { if (e.pointerId === this.rotDrag.pointerId) this.endRotateDrag(); else this.editor.finishInteraction(); return; }
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      const d = down; down = null;
      if (moved || d.onGizmo || this.tc.dragging) return;
      this.pick(e.clientX, e.clientY, d);
    });
    this.canvas.addEventListener('dblclick', (e) => { const hit = this.hitTest(e.clientX, e.clientY); if (hit?.nodeId) this.frameNodes([hit.nodeId]); });
    this.canvas.addEventListener('keydown', (e) => { if (this.editor.wasd) { const k = e.key.toLowerCase(); if ('wasdqe'.includes(k) && k.length === 1) { this.keys.add(k); e.stopPropagation(); e.preventDefault(); } } });
    this.canvas.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this.canvas.addEventListener('blur', () => this.keys.clear());
  }
  hitTest(x, y) {
    if (this.pickDirty) this.rebuildPickables();
    const rc = this.cam.ray(x, y);
    // broad phase: hidden groups are skipped; instanced meshes test their bounding sphere first
    const list = this.pickables.filter((m) => m.visible && m.parent?.visible !== false && m.parent?.parent?.visible !== false && m.parent?.parent?.parent?.visible !== false);
    const hits = rc.intersectObjects(list, false);
    if (!hits.length) return null;
    // prefer bones/targets/path points (overlay objects) when within a few pixels
    const overlayHit = hits.find((h) => h.object.userData.overlay);
    let hit = overlayHit && overlayHit.distance <= hits[0].distance + 0.3 ? overlayHit : hits[0];
    // a bounding volume (simplified / far object) must not hide real geometry behind it:
    // take the first real hit inside that volume's depth instead
    if (hit.object.userData.bounds) {
      const depth = hit.object.scale.length();
      const real = hits.find((h) => !h.object.userData.bounds && h.distance <= hit.distance + depth);
      if (real) hit = real;
    }
    const ud = hit.object.userData;
    if (ud.parts) return { nodeId: ud.nodeId, partId: partIdForInstance(ud.group, hit.instanceId) };
    if (ud.bounds) return { nodeId: ud.nodeId };
    return ud;
  }
  pick(x, y, mods) {
    const ed = this.editor;
    const ud = this.hitTest(x, y);
    if (ed.displayEdit) {
      // Edit Display Model: clicks pick individual parts (owner object stays selected)
      if (!ud) { if (!mods.shift && !mods.ctrl) ed.selectDisplayParts([]); return; }
      if (ud.partId) {
        if (ud.nodeId !== ed.active) { ed.select(ud.nodeId); ed.selectDisplayParts([ud.partId]); }
        else ed.selectDisplayParts([ud.partId], mods.ctrl ? 'toggle' : mods.shift ? 'add' : 'replace');
        return;
      }
      if (ud.nodeId) ed.select(ud.nodeId, mods.shift ? 'add' : mods.ctrl ? 'toggle' : 'replace');
      return;
    }
    if (!ud) { if (!mods.shift && !mods.ctrl) ed.deselectAll(); return; }
    if (ud.pathPoint) { ed.selectPathPoint(ud.pathPoint.wpId, ud.pathPoint.index); return; }
    if (ud.nodeId) ed.select(ud.nodeId, mods.shift ? 'add' : mods.ctrl ? 'toggle' : 'replace');
  }

  // ---------- overlay helpers ----------
  setupOverlayObjects() {
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 2 * 1024), 3));
    this.lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(3 * 2 * 1024), 3));
    this.lines = new THREE.LineSegments(this.lineGeom, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 }));
    this.lines.renderOrder = 20;
    this.lines.frustumCulled = false;
    this.overlay.add(this.lines);
  }
  setLines(segments) {
    const pos = this.lineGeom.attributes.position, col = this.lineGeom.attributes.color;
    let i = 0;
    for (const s of segments) {
      if (i + 1 >= pos.count) break;
      pos.setXYZ(i, ...s.a); pos.setXYZ(i + 1, ...s.b);
      const c = new THREE.Color(s.color);
      col.setXYZ(i, c.r, c.g, c.b); col.setXYZ(i + 1, c.r, c.g, c.b);
      i += 2;
    }
    this.lineGeom.setDrawRange(0, i);
    pos.needsUpdate = true; col.needsUpdate = true;
  }

  // ---------- node visuals ----------
  get groups() { return this.registry.entries; } // nodeId → { group, sig, meshes, edges, kind, … }
  get debug() { try { return !!(this.editor.debugViewport || globalThis.localStorage?.getItem('debugViewport')); } catch { return false; } }
  // Build the Three.js representation of one node (registry-owned: callers never keep it elsewhere).
  createGroup(node) {
    const group = new THREE.Group();
    group.userData.nodeId = node.id;
    const rec = { id: node.id, group, sig: null, meshes: [], edges: [], kind: node.type, inner: null, axes: null, pivot: null };
    if (node.type === 'object') {
      // display parts are drawn by an instanced PartsView (one draw call per geometry)
      const inner = new THREE.Group();
      rec.inner = inner;
      group.add(inner);
      rec.pv = new PartsView(node.id, makeGeometry, cachedGeometry, COLORS);
      inner.add(rec.pv.root);
      rec.partsVer = -1; rec.styleKey = ''; rec.parts = [];
    } else if (node.type === 'proxy') {
      const desc = geometryForProxy(node.shape);
      const geom = cachedGeometry('px' + node.shape, () => makeGeometry(desc));
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(node.color || '#7ec8ff'), transparent: true, opacity: 0.35, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.nodeId = node.id;
      group.add(mesh);
      rec.meshes.push(mesh);
      const edge = new THREE.LineSegments(cachedGeometry('epx' + node.shape, () => new THREE.EdgesGeometry(geom, 25)), new THREE.LineBasicMaterial({ color: COLORS.outline, depthTest: false, transparent: true, opacity: 0.9 }));
      edge.renderOrder = 15; edge.visible = false;
      group.add(edge);
      rec.edges.push(edge);
      rec.sizeMesh = mesh; rec.sizeEdge = edge;
    } else if (node.type === 'bone') {
      const mesh = new THREE.Mesh(cachedGeometry('bone', boneGeometry), new THREE.MeshBasicMaterial({ color: COLORS.bone, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 12;
      mesh.userData.nodeId = node.id; mesh.userData.overlay = true;
      const wire = new THREE.LineSegments(cachedGeometry('boneEdges', () => new THREE.EdgesGeometry(boneGeometry(), 1)), new THREE.LineBasicMaterial({ color: COLORS.bone, depthTest: false, transparent: true, opacity: 0.9 }));
      wire.renderOrder = 13;
      group.add(mesh, wire);
      rec.meshes.push(mesh); rec.boneMesh = mesh; rec.boneWire = wire;
    } else if (node.type === 'target' || node.type === 'pole') {
      const isT = node.type === 'target';
      const geom = cachedGeometry(node.type, () => isT ? new THREE.OctahedronGeometry(0.05) : new THREE.IcosahedronGeometry(0.035, 0));
      const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: isT ? COLORS.target : COLORS.pole, transparent: true, opacity: 0.75, depthTest: false }));
      mesh.renderOrder = 14;
      mesh.userData.nodeId = node.id; mesh.userData.overlay = true;
      const wire = new THREE.LineSegments(cachedGeometry('e' + node.type, () => new THREE.EdgesGeometry(geom, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.6 }));
      wire.renderOrder = 15;
      group.add(mesh, wire);
      rec.meshes.push(mesh); rec.boneMesh = mesh; rec.boneWire = wire;
    }
    // local axes + pivot dot
    const axes = new THREE.AxesHelper(0.18);
    axes.material.depthTest = false; axes.renderOrder = 16; axes.visible = false;
    group.add(axes); rec.axes = axes;
    const pivot = new THREE.Mesh(cachedGeometry('pivot', () => new THREE.SphereGeometry(1, 8, 6)), new THREE.MeshBasicMaterial({ color: COLORS.pivot, depthTest: false, transparent: true, opacity: 0.9 }));
    pivot.renderOrder = 17; pivot.visible = false;
    group.add(pivot); rec.pivot = pivot;
    this.nodeRoot.add(group);
    this.pickDirty = true;
    return rec;
  }
  // Remove a node's representation from the scene and release its own resources
  // (geometries come from the shared cache and are never disposed here).
  disposeGroup(rec) {
    if (!rec) return;
    rec.group.removeFromParent();
    if (rec.pv) rec.pv.dispose();
    rec.group.traverse((o) => { if (o.material && !o.userData.shared && !o.userData.parts && !o.userData.outline && !o.userData.bounds) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); } });
    rec.group.clear();
    if (this.drag?.starts?.has(rec.id) || this.rotDrag?.starts?.has(rec.id)) this.editor.finishInteraction(); // a drag must never outlive its object
    this.pickDirty = true;
  }
  // Full project teardown: everything under the project root goes, the gizmo detaches,
  // hover/drag state resets. The environment (camera, lights, grid, axes) survives.
  resetProject() {
    this.rotDrag = null;
    if (this.drag) this.drag = null;
    if (this.tc.dragging) { try { this.tc.pointerUp(null); } catch {} }
    this.tc.axis = null;
    this.releaseCapture(this._pointerId);
    this.cam.enabled = true;
    this.setRingHover(null);
    this.registry.clear((rec) => this.disposeGroup(rec));
    this.clearPathVisual();
    this.pathVisual.sig = null;
    this.projectRoot.removeFromParent();
    this.projectRoot = new THREE.Group(); this.projectRoot.name = 'projectRoot';
    this.nodeRoot = new THREE.Group(); this.nodeRoot.name = 'nodes';
    this.projectRoot.add(this.nodeRoot, this.pathVisual.group);
    this.scene.add(this.projectRoot);
    this.setLines([]);
    this.tc.enabled = false; this.tcHelper.visible = false; this.rg.visible = false;
    this.pickables = []; this.pickDirty = true;
    this.building = false;
  }
  // Diagnostics: does the scene graph match the editor state exactly? { ok, issues, … }
  validate({ warn = false, afterSync = false } = {}) {
    const ed = this.editor;
    if (afterSync) { try { this.sync(); } catch (e) { console.error(e); } }
    const extraIssues = [];
    for (const c of this.scene.children) if (c !== this.env && c !== this.projectRoot && c !== this.overlay) extraIssues.push({ kind: 'unknownSceneChild', id: c.name || c.type });
    for (const c of this.projectRoot.children) if (c !== this.nodeRoot && c !== this.pathVisual.group) extraIssues.push({ kind: 'strayProjectChild', id: c.name || c.type });
    if (this.tcHelper.visible && !this.gizmoTarget()) extraIssues.push({ kind: 'gizmoWithoutTarget' });
    if (this.rg.visible && !this.gizmoTarget()) extraIssues.push({ kind: 'rotateGizmoWithoutTarget' });
    const res = validateSceneModel({
      project: ed.project, registryIds: this.registry.ids(), attached: (id) => this.groups.get(id)?.group.parent === this.nodeRoot, building: !!this.building,
      rootChildCount: this.nodeRoot.children.length, gizmoIds: [this.drag?.tgt?.node?.id, this.rotDrag?.nodeId, ...(this.drag?.starts?.keys() || [])],
      selection: [...ed.selection], active: ed.active, pathPointWaypaths: (this.pathVisual.points || []).map((m) => m.userData.pathPoint.wpId), pathPointSel: ed.pathPointSel, extraIssues,
    });
    let sceneObjects = 0; this.scene.traverse(() => sceneObjects++);
    res.sceneObjects = sceneObjects;
    if (warn && !res.ok) console.warn('[viewport] state/scene mismatch', res.issues);
    return res;
  }
  // Pick list is rebuilt lazily (only when structure or visibility changed), never per frame.
  rebuildPickables() {
    this.pickables = [];
    for (const rec of this.groups.values()) { if (rec.pv) this.pickables.push(...rec.pv.pickables()); else this.pickables.push(...rec.meshes); }
    for (const m of this.pathVisual?.points || []) this.pickables.push(m);
    this.pickDirty = false;
  }

  // ---------- per-frame sync ----------
  sync() {
    const ed = this.editor;
    const project = ed.project;
    const S = project.settings;
    const dw = ed.displayWorld();
    const ikBones = new Set();
    for (const k of project.constraints) if (k.enabled) for (const b of chainBones(project, k)) ikBones.add(b.id);
    const camDist = this.cam.distance;
    const perf = ed.perfActive();
    const playing = ed.playing;
    const unknownMode = ed.view.unknownMode || 'simplified';
    const brightness = this.brightness ?? 1;
    const fov = this.cam.persp.fov, viewH = this.canvas.clientHeight || 600;
    const ortho = this.cam.projection === 'ortho';
    const camPos = this.cam.camera.position;
    // Reconcile the registry with the project (create / rebuild / update / dispose);
    // progressive construction: new objects are built within a time budget per frame.
    const t0 = performance.now();
    const ctx = { ed, project, S, dw, ikBones, camDist, perf, playing, unknownMode, brightness, fov, viewH, ortho, camPos };
    const stats = this.registry.reconcile(viewportEntities(project), {
      create: (d) => this.createGroup(d.node),
      update: (rec, d) => this.updateGroup(rec, d.node, ctx),
      dispose: (rec) => this.disposeGroup(rec),
      defer: (d) => d.type === 'object' && performance.now() - t0 > 12,
    });
    if (stats.deferred) { this.building = true; ed.setHint(t('hint.buildingScene', { n: stats.total - stats.deferred, total: stats.total })); }
    else if (this.building) { this.building = false; ed.setHint(''); }
    this.syncOverlays(ctx);
  }
  // Per-frame update of one node's representation from its state and world transform.
  updateGroup(rec, node, ctx) {
    const { ed, S, dw, ikBones, camDist, perf, playing, unknownMode, brightness, fov, viewH, ortho, camPos } = ctx;
    {
      const w = dw.get(node.id);
      if (!w) return;
      rec.group.position.fromArray(w.pos);
      rec.group.quaternion.fromArray(w.rot);
      const sel = ed.selection.has(node.id), act = ed.active === node.id;
      const hiddenByType = (node.type === 'bone' && !S.showBones) || (node.type === 'proxy' && !S.showProxies) || ((node.type === 'target' || node.type === 'pole') && !S.showConstraints);
      // Performance Mode hides non-selected rig visualisation while playing
      const perfHide = perf && playing && !sel && (node.type === 'bone' || node.type === 'target' || node.type === 'pole');
      rec.group.visible = !node.hidden && !hiddenByType && !perfHide;
      if (node.type === 'object') {
        // display-model offset (editor-only): position/rotation relative to the object
        // pivot, scale multiplied into the file's zoom
        const disp = displayOf(node), zoom = node.zoom || [1, 1, 1];
        const SP = ed.scalePreview || 1; // Scale Entire Model preview
        rec.inner.position.fromArray(v3.scale(disp.pos, SP));
        rec.inner.quaternion.fromArray(disp.rot);
        rec.inner.scale.set(zoom[0] * disp.scale[0] * SP, zoom[1] * disp.scale[1] * SP, zoom[2] * disp.scale[2] * SP);
        rec.inner.visible = S.showDecorations;
        if (!rec.group.visible) return; // nothing else to update for invisible objects
        // dirty tracking: parts + instance matrices only when the project changed
        if (rec.partsVer !== ed.changeVersion) {
          rec.parts = displayParts(node);
          rec.partsVer = ed.changeVersion;
          if (rec.pv.build(rec.parts)) this.pickDirty = true;
          rec.pv.updateTransforms(rec.parts);
          rec.styleKey = '';
        }
        // level of detail from projected size (selected objects always full)
        const lb = rec.pv.localBox;
        let lod = 'full';
        if (!lb.isEmpty()) {
          lb.getBoundingSphere(this._tmpSphere);
          const sc = Math.max(rec.inner.scale.x, rec.inner.scale.y, rec.inner.scale.z);
          const center = this._tmpV.copy(this._tmpSphere.center).multiply(rec.inner.scale).applyQuaternion(rec.inner.quaternion).add(rec.inner.position).applyQuaternion(rec.group.quaternion).add(rec.group.position);
          const dist = ortho ? this.cam.distance : camPos.distanceTo(center);
          const pr = pixelRadius(this._tmpSphere.radius * sc, dist, fov, viewH, ortho, ortho ? (this.cam.ortho.top - this.cam.ortho.bottom) : 1);
          lod = lodLevel({ pixelRadius: pr, selected: sel, perf, playing });
        }
        const editingDisplay = act && ed.displayEdit;
        const styleKey = `${sel}|${act}|${editingDisplay}|${editingDisplay ? [...ed.displaySel].join(',') : ''}|${brightness}|${S.proxyOpacity}|${lod}|${unknownMode}`;
        if (styleKey !== rec.styleKey) {
          rec.pv.updateStyle(rec.parts, { selected: sel, active: act, editing: editingDisplay, displaySel: ed.displaySel, brightness, opacity: S.proxyOpacity, lod, unknownMode });
          rec.styleKey = styleKey;
          this.pickDirty = true;
        }
      } else if (node.type === 'proxy') {
        rec.sizeMesh.scale.fromArray(v3.scale(node.size, ed.scalePreview || 1));
        rec.sizeEdge.scale.fromArray(v3.scale(node.size, ed.scalePreview || 1));
        rec.sizeMesh.material.opacity = S.proxyOpacity;
        rec.sizeMesh.material.depthWrite = S.proxyOpacity > 0.95;
        this.shade(rec.sizeMesh.material, this._tmpColor.set(node.color || '#7ec8ff'));
        rec.sizeEdge.visible = sel;
        rec.sizeEdge.material.color.set(act ? COLORS.outlineActive : COLORS.outline);
      } else if (node.type === 'bone') {
        const L = Math.max(0.01, (node.length || 0.25) * (ed.scalePreview || 1));
        rec.boneMesh.scale.set(L, L, L);
        rec.boneWire.scale.set(L, L, L);
        const c = act ? COLORS.boneActive : sel ? COLORS.boneSel : ikBones.has(node.id) ? COLORS.boneIK : COLORS.bone;
        rec.boneMesh.material.color.set(c);
        rec.boneWire.material.color.set(sel ? 0xffffff : c);
        rec.boneMesh.material.opacity = sel ? 0.75 : 0.45;
      } else {
        const c = act ? COLORS.boneActive : sel ? COLORS.boneSel : node.type === 'target' ? COLORS.target : COLORS.pole;
        rec.boneMesh.material.color.set(c);
        const s = 1 + (sel ? 0.4 : 0);
        rec.boneMesh.scale.set(s, s, s); rec.boneWire.scale.set(s, s, s);
      }
      rec.axes.visible = sel && S.showAxes;
      rec.pivot.visible = sel && S.showPivots;
      const ps = camDist * 0.004;
      rec.pivot.scale.set(ps, ps, ps);
    }
  }
  // Derived visuals (no registry entries): constraint / parent lines, previews, waypaths, gizmos.
  syncOverlays(ctx) {
    const { ed, project, S, dw } = ctx;
    // constraint lines
    const segs = [];
    if (S.showConstraints) {
      for (const k of project.constraints) {
        const chain = chainBones(project, k);
        const tip = chain[chain.length - 1];
        const target = getNode(project, k.targetId);
        if (tip && target && dw.get(tip.id) && dw.get(target.id)) {
          const tw = dw.get(tip.id);
          const tail = v3.add(tw.pos, quat.rotate(tw.rot, [0, tip.length || 0.25, 0]));
          segs.push({ a: tail, b: dw.get(target.id).pos, color: k.enabled ? COLORS.constraint : 0x6b7482 });
        }
        const pole = k.poleId ? getNode(project, k.poleId) : null;
        if (pole && chain.length > 1 && dw.get(pole.id)) {
          const mid = chain[Math.floor(chain.length / 2)];
          if (dw.get(mid.id)) segs.push({ a: dw.get(mid.id).pos, b: dw.get(pole.id).pos, color: COLORS.poleLine });
        }
      }
    }
    // Auto-Rig preview: proposed bones as head → tail lines
    if (ed.rigPreview) for (const b of ed.rigPreview.bones) if (!b.skip) segs.push({ a: b.head, b: b.tail, color: COLORS.rigPreview });
    // export path compression preview: original path dim, compressed path bright
    if (ed.exportPathPreview) for (const path of ed.exportPathPreview) for (let i = 1; i < path.points.length; i++) segs.push({ a: path.points[i - 1], b: path.points[i], color: path.color });
    // parent relationship lines for selected bones/nodes
    for (const id of ed.selection) {
      const n = getNode(project, id);
      if (!n || !n.parent || !dw.get(id) || !dw.get(n.parent)) continue;
      const p = getNode(project, n.parent);
      const from = p.type === 'bone' ? v3.add(dw.get(p.id).pos, quat.rotate(dw.get(p.id).rot, [0, p.length || 0.25, 0])) : dw.get(p.id).pos;
      segs.push({ a: from, b: dw.get(id).pos, color: 0x9aa3b0 });
    }
    this.setLines(segs);
    this.grid.visible = S.showGrid;
    this.axes.visible = S.showGrid;
    this.syncWaypaths();

    // gizmos: TransformControls for Move, ring gizmo for Rotate
    const tgt = this.gizmoTarget();
    const showMove = !!tgt && (ed.tool === 'move' || (ed.tool === 'scale' && (tgt.kind === 'display' || tgt.kind === 'parts')));
    const mode = ed.tool === 'scale' ? 'scale' : 'translate';
    if (this.tc.mode !== mode) this.tc.setMode(mode);
    const space = mode === 'scale' ? 'local' : ed.space;
    if (this.tc.space !== space) this.tc.setSpace(space);
    // TransformControls ignores pointerup while disabled: settle a drag before hiding it,
    // and drop stale dragging/hover state so it can never block picking or the camera
    if (this.tc.dragging && !showMove) { if (ed.interactionKind === 'gizmo-move') ed.finishInteraction(); else this.settleMove(false); }
    if (this.tc.dragging && !this.drag) this.settleMove(false);
    if (!showMove && this.tc.axis) this.tc.axis = null;
    this.tc.enabled = showMove;
    this.tcHelper.visible = showMove;
    if (showMove && !this.drag) {
      this.handle.position.fromArray(tgt.pos);
      this.handle.quaternion.fromArray(tgt.rot);
      this.handle.scale.set(1, 1, 1); // scale drags are relative to the start
    }
    if (this.tc.camera !== this.cam.camera) this.tc.camera = this.cam.camera;
    const showRot = !!tgt && (tgt.kind === 'node' || tgt.kind === 'display' || tgt.kind === 'parts') && ed.tool === 'rotate';
    this.rg.visible = showRot;
    if (showRot) {
      const pos = this.rotDrag ? this.rotDrag.pivot : tgt.pos;
      this.rg.position.fromArray(pos);
      if (ed.space === 'local') this.rg.quaternion.fromArray(tgt.rot); else this.rg.quaternion.identity();
      this.rg.scale.setScalar(this.gizmoRadius(pos));
    } else if (this.rgHover) this.setRingHover(null);
  }

  syncWaypaths() {
    const ed = this.editor;
    const S = ed.project.settings;
    const wps = ed.project.waypaths;
    const sig = S.showWaypaths ? JSON.stringify(wps.map((w) => [w.id, w.kind, w.direction, w.velocity, w.duration, w.useVelocity, w.useDuration, w.points, w.enabled, w.id === ed.project.activeWaypathId])) + JSON.stringify(ed.pathPointSel) + JSON.stringify(ed.scenePivot()) : 'off';
    if (sig === this.pathVisual.sig) return;
    this.pathVisual.sig = sig;
    const g = this.pathVisual.group;
    this.clearPathVisual();
    if (S.showWaypaths) {
      const pivot = ed.scenePivot();
      for (const wp of wps) {
        const active = wp.id === ed.project.activeWaypathId;
        let pts;
        if (wp.kind === 'direction') { const e = effectiveDirectional(wp); pts = [pivot, v3.add(pivot, v3.scale(e.dir, e.distance))]; }
        else pts = wp.points.map((p) => v3.add(pivot, p));
        const color = active ? COLORS.path : 0x4a5160;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: active ? 0.95 : 0.5 }));
        line.renderOrder = 18;
        g.add(line);
        for (let i = 1; i < pts.length; i++) {
          const a = new THREE.Vector3(...pts[i - 1]), b = new THREE.Vector3(...pts[i]);
          const len = a.distanceTo(b);
          if (len < 1e-4) continue;
          const dir = b.clone().sub(a).normalize();
          const arrow = new THREE.ArrowHelper(dir, a.clone().lerp(b, 0.55), Math.min(0.25, len * 0.4), color, Math.min(0.12, len * 0.25), Math.min(0.06, len * 0.12));
          arrow.line.material.depthTest = false; arrow.cone.material.depthTest = false;
          arrow.renderOrder = 18;
          g.add(arrow);
        }
        if (wp.kind === 'manual') {
          pts.forEach((p, i) => {
            const selP = ed.pathPointSel && ed.pathPointSel.wpId === wp.id && ed.pathPointSel.index === i;
            const m = new THREE.Mesh(cachedGeometry('pathpt', () => new THREE.SphereGeometry(0.03, 10, 8)), new THREE.MeshBasicMaterial({ color: selP ? COLORS.pathPointSel : active ? COLORS.pathPoint : 0x6b7482, depthTest: false }));
            m.position.set(...p); m.renderOrder = 19;
            m.userData.pathPoint = { wpId: wp.id, index: i }; m.userData.overlay = true; m.userData.shared = true;
            g.add(m);
            this.pathVisual.points.push(m);
          });
        }
      }
    }
    this.pickDirty = true;
  }

  clearPathVisual() {
    const g = this.pathVisual.group;
    for (const c of [...g.children]) {
      // ArrowHelper geometries are module-level shared objects in Three; path points use the shared cache
      c.traverse((o) => {
        if (o.geometry && !o.userData.shared && !c.isArrowHelper) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
      g.remove(c);
    }
    this.pathVisual.points = [];
    this.pickDirty = true;
  }

  // ---------- framing ----------
  boundsOf(ids) {
    const box = new THREE.Box3();
    const dw = this.editor.displayWorld();
    for (const id of ids) {
      const rec = this.groups.get(id);
      const node = getNode(this.editor.project, id);
      if (!rec || !node) continue;
      rec.group.updateMatrixWorld(true);
      if (node.type === 'object' && rec.pv) { if (!rec.pv.localBox.isEmpty()) { rec.inner.updateMatrixWorld(true); box.union(rec.pv.localBox.clone().applyMatrix4(rec.inner.matrixWorld)); } else { const w = dw.get(id); if (w) box.expandByPoint(new THREE.Vector3(...w.pos)); } }
      else if (node.type === 'proxy') box.expandByObject(rec.sizeMesh);
      else if (node.type === 'bone') { const w = dw.get(id); box.expandByPoint(new THREE.Vector3(...w.pos)); box.expandByPoint(new THREE.Vector3(...boneTail(node, dw))); }
      else { const w = dw.get(id); if (w) { const p = new THREE.Vector3(...w.pos); box.expandByPoint(p.clone().addScalar(-0.1)); box.expandByPoint(p.clone().addScalar(0.1)); } }
    }
    return box;
  }
  frameNodes(ids) { const box = this.boundsOf(ids); if (!box.isEmpty()) this.cam.frame(box); }
  frameSelected() { const ids = [...this.editor.selection]; if (ids.length) this.frameNodes(ids); else this.frameAll(); }
  frameAll() { this.frameNodes(this.editor.project.nodes.filter((n) => !n.hidden).map((n) => n.id)); }
  setView(name) { const d = VIEW_DIRS[name]; if (d) this.cam.snapToView(d); }

  loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.clock) / 1000);
    this.clock = now;
    this.editor.tick(dt);
    if (this.editor.wasd && this.keys.size && document.activeElement === this.canvas) this.cam.fly(this.keys, dt, false);
    try { this.sync(); } catch (e) { console.error(e); }
    this.renderer.render(this.scene, this.cam.camera);
    this.nav.draw();
    requestAnimationFrame(() => this.loop());
  }
}

function isAncestorOf(project, ancestorId, nodeId) {
  let cur = getNode(project, nodeId), guard = 0;
  while (cur && cur.parent && guard++ < 1000) { if (cur.parent === ancestorId) return true; cur = getNode(project, cur.parent); }
  return false;
}
