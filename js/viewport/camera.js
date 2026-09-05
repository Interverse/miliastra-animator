// Blender-like camera controller: orbit (middle drag / alt+left), pan
// (shift+middle / right drag), dolly (wheel / ctrl+middle), perspective ↔
// orthographic, standard views, framing and optional WASD fly navigation
// (hold the right mouse button, or enable WASD mode).
import * as THREE from 'three';

export class CameraController {
  constructor(dom, opts = {}) {
    this.dom = dom;
    this.persp = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.projection = 'persp';
    this.target = new THREE.Vector3(0, 0.5, 0);
    this.distance = 4;
    this.theta = Math.PI / 4 + Math.PI; // azimuth (default: front-right, matching "Front" looking along +Z)
    this.phi = Math.PI / 3; // polar angle from +Y
    this.wasd = !!opts.wasd;
    // navigation preferences (viewport drags only; wheel zoom and the nav gizmo are unaffected)
    this.reversePanX = !!opts.reversePanX;
    this.reversePanY = !!opts.reversePanY;
    this.reverseOrbitX = !!opts.reverseOrbitX;
    this.reverseOrbitY = !!opts.reverseOrbitY;
    this.onChange = opts.onChange || (() => {});
    // interaction ownership hooks (mode, pointerId) — see editor.beginInteraction
    this.onDragStart = opts.onDragStart || (() => {});
    this.onDragEnd = opts.onDragEnd || (() => {});
    this.keys = new Set();
    this._drag = null;
    this.enabled = true;
    this.bind();
    this.update();
  }
  get camera() { return this.projection === 'persp' ? this.persp : this.ortho; }
  get quaternion() { return this.camera.quaternion; }
  resize(w, h) {
    this.aspect = Math.max(1e-3, w / Math.max(1, h));
    this.persp.aspect = this.aspect;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }
  updateOrtho() {
    const h = this.distance * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const w = h * (this.aspect || 1);
    this.ortho.left = -w; this.ortho.right = w; this.ortho.top = h; this.ortho.bottom = -h;
    this.ortho.updateProjectionMatrix();
  }
  update() {
    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    const dir = new THREE.Vector3(sp * Math.sin(this.theta), cp, sp * Math.cos(this.theta));
    const pos = this.target.clone().add(dir.multiplyScalar(this.distance));
    for (const cam of [this.persp, this.ortho]) {
      cam.position.copy(pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.target);
      cam.updateMatrixWorld();
    }
    this.updateOrtho();
    this.onChange();
  }
  orbit(dx, dy) {
    this.theta -= dx;
    this.phi = THREE.MathUtils.clamp(this.phi + dy, 0.02, Math.PI - 0.02);
    this.update();
  }
  pan(dx, dy) {
    // dx, dy in pixels
    const h = this.dom.clientHeight || 1;
    const worldPerPx = (2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / h;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.target.add(right.multiplyScalar(-dx * worldPerPx)).add(up.multiplyScalar(dy * worldPerPx));
    this.update();
  }
  dolly(factor) {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, 0.05, 500);
    this.update();
  }
  setProjection(p) { this.projection = p; this.update(); }
  toggleProjection() { this.setProjection(this.projection === 'persp' ? 'ortho' : 'persp'); }
  // snap the view so the camera looks along -dir (dir = direction from target to camera)
  snapToView(dir, ortho = null) {
    const d = dir.clone().normalize();
    this.phi = Math.acos(THREE.MathUtils.clamp(d.y, -1, 1));
    if (Math.abs(d.y) > 0.9999) { this.theta = this.theta; this.phi = d.y > 0 ? 0.02 : Math.PI - 0.02; }
    else this.theta = Math.atan2(d.x, d.z);
    if (ortho != null) this.projection = ortho ? 'ortho' : 'persp';
    this.update();
  }
  frame(box) {
    if (!box || box.isEmpty()) { this.target.set(0, 0.5, 0); this.distance = 4; this.update(); return; }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(sphere.center);
    const r = Math.max(0.05, sphere.radius);
    this.distance = r / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.05;
    this.update();
  }
  // screen point → world ray
  ray(x, y) {
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }
  bind() {
    const dom = this.dom;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      const orbitBtn = e.button === 1 || (e.button === 0 && e.altKey);
      const panBtn = e.button === 2 && !this.wasd;
      const flyBtn = e.button === 2 && this.wasd;
      if (!orbitBtn && !panBtn && !flyBtn) return;
      e.preventDefault();
      const mode = orbitBtn ? (e.shiftKey ? 'pan' : e.ctrlKey ? 'dolly' : 'orbit') : flyBtn ? 'fly' : 'pan';
      this.onDragStart(mode, e.pointerId); // may finish another interaction first
      this._drag = { x: e.clientX, y: e.clientY, mode, id: e.pointerId, moved: false, middle: e.button === 1 };
      try { dom.setPointerCapture(e.pointerId); } catch {}
      dom.focus();
    });
    dom.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
      if (d.mode === 'orbit' || d.mode === 'fly') {
        const ox = this.reverseOrbitX ? -1 : 1, oy = this.reverseOrbitY ? -1 : 1;
        this.orbit(dx * 0.008 * ox, dy * 0.008 * oy);
      }
      else if (d.mode === 'pan') {
        // pan-direction preferences apply to middle-mouse panning only
        const sx = d.middle && this.reversePanX ? -1 : 1, sy = d.middle && this.reversePanY ? -1 : 1;
        this.pan(dx * sx, dy * sy);
      }
      else if (d.mode === 'dolly') this.dolly(Math.exp(dy * 0.01));
    });
    const end = (e) => { if (this._drag && this._drag.id === e.pointerId) this.cancelDrag(); };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('lostpointercapture', end);
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      if (e.ctrlKey) this.pan(0, -e.deltaY * 0.5);
      else if (e.shiftKey) this.pan(-e.deltaY * 0.5, 0);
      else this.dolly(Math.exp(Math.sign(e.deltaY) * 0.12));
    }, { passive: false });
  }
  isDragging() { return !!this._drag; }
  // Ends the current navigation drag from any path (event, failsafe, tool switch).
  cancelDrag() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    try { if (this.dom.hasPointerCapture?.(d.id)) this.dom.releasePointerCapture(d.id); } catch {}
    this.onDragEnd(d.mode);
  }
  // WASD fly step, called every frame with dt seconds when keys are held
  fly(keys, dt, fast = false) {
    if (!keys.size) return false;
    const speed = (fast ? 4 : 1.2) * this.distance * dt;
    const q = this.camera.quaternion;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0);
    const mv = new THREE.Vector3();
    if (keys.has('w')) mv.add(fwd);
    if (keys.has('s')) mv.sub(fwd);
    if (keys.has('d')) mv.add(right);
    if (keys.has('a')) mv.sub(right);
    if (keys.has('e')) mv.add(up);
    if (keys.has('q')) mv.sub(up);
    if (mv.lengthSq() === 0) return false;
    this.target.add(mv.normalize().multiplyScalar(speed));
    this.update();
    return true;
  }
}
