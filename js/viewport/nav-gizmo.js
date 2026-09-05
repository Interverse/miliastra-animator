// Camera orientation gizmo (axis ball): shows the current orientation, snaps
// to the six standard views when a knob is clicked, orbits when dragged and
// toggles Perspective / Orthographic via the button below it.
import * as THREE from 'three';
import { t, onLangChange } from '../i18n/i18n.js';

// display space mirrors X vs the game axes: game +X lies toward display -X
export const AXES = [
  { dir: new THREE.Vector3(-1, 0, 0), label: 'X', color: '#e5534b', view: 'view.right' },
  { dir: new THREE.Vector3(1, 0, 0), label: '-X', color: '#e5534b', view: 'view.left' },
  { dir: new THREE.Vector3(0, 1, 0), label: 'Y', color: '#57ab5a', view: 'view.top' },
  { dir: new THREE.Vector3(0, -1, 0), label: '-Y', color: '#57ab5a', view: 'view.bottom' },
  { dir: new THREE.Vector3(0, 0, 1), label: 'Z', color: '#539bf5', view: 'view.back' },
  { dir: new THREE.Vector3(0, 0, -1), label: '-Z', color: '#539bf5', view: 'view.front' },
];
export const VIEW_DIRS = {
  front: AXES[5].dir, back: AXES[4].dir, right: AXES[0].dir, left: AXES[1].dir, top: AXES[2].dir, bottom: AXES[3].dir,
};

export function createNavGizmo(cam, onViewChange) {
  const canvas = document.getElementById('nav-gizmo');
  const btn = document.getElementById('nav-proj');
  const SIZE = 96;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const C = SIZE / 2, R = SIZE / 2 - 14, KNOB = 8.5;
  let hovered = -1, inside = false, drag = null;
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  const pts = AXES.map(() => ({ x: 0, y: 0, z: 0 }));

  function project() {
    q.copy(cam.quaternion).invert();
    for (let i = 0; i < AXES.length; i++) {
      v.copy(AXES[i].dir).applyQuaternion(q);
      pts[i].x = C + v.x * R; pts[i].y = C - v.y * R; pts[i].z = v.z;
    }
  }
  function draw() {
    project();
    g.clearRect(0, 0, SIZE, SIZE);
    if (inside || drag) { g.beginPath(); g.arc(C, C, SIZE / 2 - 2, 0, Math.PI * 2); g.fillStyle = 'rgba(32,36,44,.55)'; g.fill(); }
    const order = AXES.map((_, i) => i).sort((a, b) => pts[a].z - pts[b].z);
    for (const i of order) {
      const p = pts[i], positive = !AXES[i].label.startsWith('-'), near = (p.z + 1) / 2, r = KNOB * (0.75 + 0.25 * near);
      if (positive) { g.beginPath(); g.moveTo(C, C); g.lineTo(p.x, p.y); g.strokeStyle = AXES[i].color; g.globalAlpha = 0.45 + 0.55 * near; g.lineWidth = 2; g.stroke(); }
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (positive) { g.fillStyle = AXES[i].color; g.globalAlpha = 0.55 + 0.45 * near; g.fill(); }
      else { g.fillStyle = '#1b1e24'; g.globalAlpha = 0.85; g.fill(); g.beginPath(); g.arc(p.x, p.y, r - 1, 0, Math.PI * 2); g.strokeStyle = AXES[i].color; g.globalAlpha = 0.35 + 0.55 * near; g.lineWidth = 1.5; g.stroke(); }
      if (i === hovered) { g.beginPath(); g.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.globalAlpha = 0.9; g.lineWidth = 1.5; g.stroke(); }
      if (positive || i === hovered) {
        g.globalAlpha = 1; g.fillStyle = positive ? '#14161a' : AXES[i].color; g.font = 'bold 9px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(AXES[i].label.replace('-', '−'), p.x, p.y + 0.5);
      }
    }
    g.globalAlpha = 1;
  }
  function knobAt(x, y) {
    let best = -1, bestD = 12, bestZ = -2;
    for (let i = 0; i < AXES.length; i++) {
      const d = Math.hypot(pts[i].x - x, pts[i].y - y);
      if (d <= bestD + 0.001 && pts[i].z >= bestZ) { best = i; bestD = Math.min(bestD, d); bestZ = pts[i].z; }
    }
    return best;
  }
  const localXY = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * SIZE, y: ((ev.clientY - r.top) / r.height) * SIZE }; };
  canvas.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; ev.preventDefault(); ev.stopPropagation(); drag = { x: ev.clientX, y: ev.clientY, moved: false }; try { canvas.setPointerCapture(ev.pointerId); } catch {} });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true; cam.orbit(dx * 0.012, dy * 0.012); drag.x = ev.clientX; drag.y = ev.clientY; return;
    }
    const { x, y } = localXY(ev);
    const k = knobAt(x, y);
    if (k !== hovered) { hovered = k; canvas.title = k >= 0 ? t('nav.viewtitle', { v: t(AXES[k].view) }) : t('tip.nav'); draw(); }
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const wasClick = !drag.moved; drag = null;
    if (wasClick) { const { x, y } = localXY(ev); const k = knobAt(x, y); if (k >= 0) { cam.snapToView(AXES[k].dir); onViewChange?.(AXES[k].view); } }
  });
  canvas.addEventListener('pointerenter', () => { inside = true; draw(); });
  canvas.addEventListener('pointerleave', () => { inside = false; hovered = -1; draw(); });
  const syncBtn = () => { btn.textContent = t(cam.projection === 'ortho' ? 'nav.ortho' : 'nav.persp'); btn.title = t('tip.nav.proj'); };
  btn.addEventListener('click', () => { cam.toggleProjection(); syncBtn(); });
  syncBtn();
  onLangChange(syncBtn);
  return { draw, syncBtn };
}
