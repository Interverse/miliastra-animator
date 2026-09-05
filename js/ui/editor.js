// Central editor state and commands. Every mutation of the project goes
// through here so undo/redo, autosave and UI refresh stay consistent.
import { createProject, createNode, getNode, childrenOf, descendants, reparent, deleteNode, worldTransforms, setWorldTransform, localTransform, parentWorld, orderedNodes, isAncestor, boneTail } from '../scene/scene.js';
import * as DP from '../scene/display-parts.js';
import { perfModeActive } from '../viewport/parts-plan.js';
import { proposeRig, applyRig } from '../rig/autorig.js';
import { v3, quat, xf } from '../core/math.js';
import { History } from '../core/history.js';
import { saveRecovery, clearRecovery, loadPrefs, updatePrefs, putProject, getProject, deleteProject, newProjectId, isQuotaError, PROJECT_SCHEMA } from '../core/persistence.js';
import { createClip, uniqueClipName, duplicateClip, getClip, activeClip, insertKey, keyRef, moveKeys, deleteKeys, copyKeys, pasteKeys, setInterpolation, clipEnd, track, evaluateKeys, snapTime } from '../anim/clips.js';
import { evaluatePose } from '../anim/evaluate.js';
import { createConstraint, chainBones } from '../anim/ik.js';
import { createWaypath, evaluateWaypath, bakeWaypathKeys, pathDuration } from '../anim/waypath.js';
import { importGia } from '../gia/gia-import.js';
import { exportGia, exportPlacement, exportSlots, initialSlotIndex, toWaypoint, exportPivot, outputRotation } from '../gia/gia-export.js';
import { restWorld } from '../anim/evaluate.js';
import { displayQuatToGameEuler, displayToGamePos } from '../core/math.js';
import { validateProject, hasErrors } from '../validation.js';
import { MAX_DEVICES_PER_OBJECT } from '../gia/motion-device.js';
import { t } from '../i18n/i18n.js';

// Display-model offset of an object (identity when unset). Editor-only data.
export const DISPLAY_IDENTITY = Object.freeze({ pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] });
export function displayOf(node) {
  const d = node?.display;
  return d ? { pos: d.pos || [0, 0, 0], rot: d.rot || [0, 0, 0, 1], scale: d.scale || [1, 1, 1] } : DISPLAY_IDENTITY;
}
// IK targets and poles: only their position affects the rig (the solver ignores rotation)
export function isPositionOnly(node) { return !!node && (node.type === 'target' || node.type === 'pole'); }
export function hasDisplayOffset(node) {
  const d = node?.display;
  return !!d && (d.pos?.some((x) => x) || (d.rot && quat.angle(d.rot, [0, 0, 0, 1]) > 1e-9) || d.scale?.some((s) => Math.abs(s - 1) > 1e-9));
}
import { toast, textPrompt } from './dialogs.js';

async function textPromptSafe(title, label, value) {
  if (typeof document === 'undefined') return value;
  return textPrompt({ title, label, value });
}

export class Editor {
  constructor() {
    this.project = createProject();
    this.giaBytes = null;
    this.giaName = null;
    this.importInfo = null;
    this.history = new History();
    this.resetTransientState();
    this._committedProjectJson = null;
    this.history.reset(this.snapshotState());
    this.selection = new Set();
    this.active = null;
    this.selectedKeys = new Set();
    this.keyClipboard = null;
    this.mode = 'rig';
    this.tool = 'select';
    this.space = 'world';
    const prefs = loadPrefs();
    this.snap = { enabled: false, pos: 0.1, rot: 15, ...(prefs.snap || {}) };
    this.timeDisplay = prefs.timeDisplay || 'frames';
    this.wasd = !!prefs.wasd;
    this.view = { brightness: 1, reversePanX: false, reversePanY: false, reverseOrbitX: false, reverseOrbitY: false, unknownMode: 'simplified', perfMode: 'auto', ...(prefs.view || {}) };
    // bumped on every project change so renderers can skip unchanged work
    this.changeVersion = 0;
    this.rigPreview = null;
    // 'normal': children inherit the rotation; 'preserve': reorient the node while
    // descendants keep their world transforms (rest/rig edit, rebases keyframes)
    this.rotateMode = prefs.rotateMode === 'preserve' ? 'preserve' : 'normal';
    this._reorient = null;
    this.playing = false;
    // Outliner disclosure state (session-level, not part of undo):
    //   expandedDecos – objects whose decoration list is shown (default: none)
    //   collapsed     – nodes whose child nodes are hidden (default: none)
    this.expandedDecos = new Set();
    this.collapsed = new Set();
    this.pathPointSel = null;
    this.listeners = new Map();
    this._pose = null;
    // exclusive pointer interaction (beginInteraction) + unkeyed pose edits (setPoseOverride)
    this.interaction = null;
    this.poseOverrides = new Map();
    this._overrideVer = 0;
    this.exportPreviewSlot = null;
    // Edit Display Model mode: gizmos edit the object's display geometry offset
    // (node.display: pos/rot/scale, editor-only, never exported) instead of the object
    this.displayEdit = false;
    // selected display parts of the active object (session state)
    this.displaySel = new Set();
    this.displayActive = null;
    this._saveTimer = null;
    this.lastReport = null;
    this.hint = '';
    // local project identity + dirty tracking
    this.projectId = null;
    this.projectName = '';
    this.createdAt = null;
    this.dirty = false;
    this.lastSavedAt = null;
  }

  // ---------- events ----------
  on(evt, fn) { if (!this.listeners.has(evt)) this.listeners.set(evt, new Set()); this.listeners.get(evt).add(fn); return () => this.listeners.get(evt).delete(fn); }
  emit(evt, detail) {
    // renderers rebuild part instances only when project DATA changed: time scrubs,
    // playback ticks and view preferences are not data changes
    if (evt === 'change' && !detail?.time && !detail?.view) this.changeVersion++;
    for (const fn of this.listeners.get(evt) || []) fn(detail);
  }

  invalidate() { this._pose = null; }

  // ---------- interaction state machine ----------
  // Exactly one exclusive pointer interaction owns the pointer at a time:
  //   idle | gizmo-move | gizmo-rotate | viewport-orbit | viewport-pan | viewport-dolly |
  //   viewport-fly | timeline-scrub | timeline-move | timeline-box | timeline-pan | panel-resize
  // The owner registers `finish` (keep what was applied, commit) and `cancel`
  // (restore the drag-start state). Every transition back to idle runs exactly
  // one of them, and starting a new interaction finishes the previous one, so a
  // missed browser event can never leave the editor "dragging" forever.
  get interactionKind() { return this.interaction?.kind || 'idle'; }
  beginInteraction(kind, { finish = null, cancel = null, pointerId = null } = {}) {
    if (this.interaction) this.finishInteraction();
    if (this.playing && kind.startsWith('gizmo')) this.pause(); // editing never fights playback
    this.interaction = { kind, finish, cancel: cancel || finish, pointerId, startedAt: Date.now(), overrides: this.snapshotOverrides() };
    this.emit('interaction');
    return this.interaction;
  }
  // Normal completion reported by the owner (no-op when something else already ended it).
  endInteraction(kind = null) {
    if (!this.interaction || (kind && this.interaction.kind !== kind)) return false;
    this.interaction = null;
    this.emit('interaction');
    return true;
  }
  finishInteraction() { return this._settleInteraction('finish'); }
  cancelInteraction() { return this._settleInteraction('cancel'); }
  // Finish only a transform (gizmo) interaction; used before selection/tool changes.
  settleGizmo() { if (this.interaction?.kind.startsWith('gizmo')) return this.finishInteraction(); return false; }
  _settleInteraction(how) {
    const i = this.interaction;
    if (!i) return false;
    this.interaction = null; // cleared first: owner callbacks cannot re-enter
    try { const fn = i[how]; if (fn) fn(); } catch (e) { console.error(`interaction ${how} failed`, e); }
    if (how === 'cancel') this.restoreOverrides(i.overrides);
    this.emit('interaction');
    return true;
  }
  // Revert every uncommitted (transient) project change to the last history state.
  restoreCommitted() {
    this._reorient = null;
    const json = this.history.current?.json;
    if (!json) return;
    const st = this.parseState(JSON.parse(json));
    this.project = this.keepPlayheads(st.project);
    this.poseOverrides = new Map(st.overrides);
    this._overrideVer++;
    this.pruneSelection();
    this.invalidate();
    this.emit('change', { label: 'cancel' });
    this.emit('selection');
    this.emit('time');
  }
  // Drops all session-only editing state (called whenever a different project is loaded).
  resetTransientState() {
    this.interaction = null;
    this.exportPreviewSlot = null;
    this.displayEdit = false;
    this.displaySel = new Set(); this.displayActive = null;
    if (this.tool === 'scale') this.tool = 'move';
    this._reorient = null;
    this.poseOverrides = new Map();
    this._overrideVer = (this._overrideVer || 0) + 1;
  }

  // Undo snapshots carry the project plus the unkeyed pose edits, so undoing a
  // transform always moves the node back even when nothing was keyed.
  snapshotState() { return { project: this.projectForSnapshot(), overrides: [...this.poseOverrides] }; }
  // Playheads are session state, not edits: snapshots carry them as 0 (same key order) so
  // scrubbing never counts as a change, and keepPlayheads() puts the live values back.
  projectForSnapshot() { return { ...this.project, clips: this.project.clips.map((c) => ({ ...c, playhead: 0 })) }; }
  parseState(state) { return state && Array.isArray(state.overrides) && state.project ? state : { project: state, overrides: [] }; }

  // ---------- unkeyed pose edits ----------
  // With Auto Key off, editing an animated channel where no key exists changes the
  // pose shown at the playhead without touching the project (Blender-style):
  // Insert Keyframe turns it into a key, changing frame/clip discards it. The
  // evaluator applies these on top of the clip, so a transform is never
  // silently overwritten by the keyframe value while the user is editing.
  // Overrides are tagged with the clip and time they were made at and only apply
  // there, so undo/redo can never show a frame-10 pose edit on frame 20.
  setPoseOverride(id, ch, val) {
    const clipId = this.project.activeClipId, t = this.time;
    const prev = this.poseOverrides.get(id);
    const o = prev && prev.clipId === clipId && Math.abs(prev.t - t) < 1e-6 ? { ...prev } : { clipId, t };
    o[ch] = val.slice();
    this.poseOverrides.set(id, o);
    this._overrideVer++;
    this.invalidate();
  }
  overrideActive(o) { return !!o && o.clipId === this.project.activeClipId && Math.abs((o.t || 0) - this.time) < 1e-6; }
  activeOverrides() {
    if (!this.poseOverrides.size) return null;
    const out = new Map();
    for (const [id, o] of this.poseOverrides) if (this.overrideActive(o)) out.set(id, o);
    return out.size ? out : null;
  }
  clearPoseOverrides(ids = null, channels = null) {
    if (!this.poseOverrides.size) return false;
    let changed = false;
    for (const id of ids || [...this.poseOverrides.keys()]) {
      const o = this.poseOverrides.get(id);
      if (!o) continue;
      if (channels) {
        for (const ch of channels) if (o[ch]) { delete o[ch]; changed = true; }
        if (!o.pos && !o.rot) this.poseOverrides.delete(id);
      } else { this.poseOverrides.delete(id); changed = true; }
    }
    if (changed) { this._overrideVer++; this.invalidate(); this.emit('overrides'); }
    return changed;
  }
  hasPoseOverride(id, ch = null) { const o = this.poseOverrides.get(id); return this.overrideActive(o) && (ch ? !!o[ch] : !!(o.pos || o.rot)); }
  snapshotOverrides() { return new Map([...this.poseOverrides].map(([id, o]) => [id, { ...o }])); }
  restoreOverrides(snap) {
    this.poseOverrides = new Map([...(snap || [])].map(([id, o]) => [id, { ...o }]));
    this._overrideVer++;
    this.invalidate();
    this.emit('overrides');
  }
  // The enabled IK constraint whose chain solves this bone's rotation (null when FK-editable).
  constraintDriving(id) {
    for (const k of this.project.constraints) {
      if (!k.enabled || (k.influence ?? 1) <= 0) continue;
      if (chainBones(this.project, k).some((b) => b.id === id)) return k;
    }
    return null;
  }
  // structural / data change recorded in history
  commit(label = '') {
    this.invalidate();
    const prevJson = this.history.current?.json;
    const changed = this.history.commit(this.snapshotState(), label);
    if (changed) {
      // unkeyed pose edits are undoable but never saved: only real project changes dirty it
      const pj = JSON.stringify(this.projectForSnapshot());
      const prev = this._committedProjectJson ?? (prevJson ? JSON.stringify(this.parseState(JSON.parse(prevJson)).project) : null);
      this._committedProjectJson = pj;
      if (pj !== prev) this.setDirty(true);
    }
    this.emit('change', { label });
    this.scheduleSave();
  }
  setDirty(v) { if (this.dirty !== v) { this.dirty = v; this.emit('dirty'); } }
  // preview-only change (during drags): no history entry
  transient() { this.invalidate(); this.emit('change', { transient: true }); }
  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => saveRecovery(this.recoveryRecord()), 900);
  }
  recoveryRecord() {
    return { project: this.project, giaBytes: this.giaBytes, giaName: this.giaName, ui: this.outlinerState(), projectId: this.projectId, projectName: this.projectName, createdAt: this.createdAt, dirty: this.dirty };
  }
  // ---------- local projects (IndexedDB) ----------
  projectMeta() {
    const p = this.project;
    return {
      objects: p.nodes.filter((n) => n.type === 'object').length,
      bones: p.nodes.filter((n) => n.type === 'bone').length,
      clips: p.clips.length,
      keys: p.clips.reduce((a, c) => a + Object.values(c.tracks).reduce((b, tr) => b + tr.pos.length + tr.rot.length, 0), 0),
    };
  }
  defaultProjectName() { return (this.giaName || '').replace(/\.gia$/i, '') || t('project.untitled'); }
  projectRecord() {
    return {
      id: this.projectId, schema: PROJECT_SCHEMA, name: this.projectName, giaName: this.giaName,
      createdAt: this.createdAt, modifiedAt: Date.now(), meta: this.projectMeta(),
      project: this.project, giaBytes: this.giaBytes, ui: this.outlinerState(),
    };
  }
  // Save (update the current project) or Save As (new id/name). Returns the id or null.
  async saveLocal({ as = false, name = null } = {}) {
    if (!this.project.nodes.length && !this.project.clips.length) { toast(t('toast.nothingToSave'), 'info'); return null; }
    if (as || !this.projectId) {
      const proposed = name ?? this.projectName ?? '';
      const chosen = name || await textPromptSafe(t(as ? 'project.saveAs' : 'project.saveLocal'), t('project.namePrompt'), proposed || this.defaultProjectName());
      if (!chosen) return null;
      this.projectId = newProjectId();
      this.projectName = chosen;
      this.createdAt = Date.now();
    }
    try {
      await putProject(this.projectRecord());
    } catch (e) {
      console.error(e);
      toast(isQuotaError(e) ? t('toast.saveQuota') : t('toast.saveFailed', { err: e.message || e.name }), 'error', 5000);
      return null;
    }
    this.lastSavedAt = Date.now();
    this.setDirty(false);
    this.scheduleSave();
    this.emit('projects');
    toast(t('toast.savedLocally', { name: this.projectName }), 'success', 1800);
    return this.projectId;
  }
  async loadLocal(id) {
    const rec = await getProject(id);
    if (!rec) { toast(t('toast.projectMissing'), 'error'); return false; }
    this.applyRecord(rec);
    return true;
  }
  applyRecord(rec, { dirty = false } = {}) {
    this.project = { ...createProject(), ...rec.project };
    this.project.settings = { ...createProject().settings, ...(rec.project?.settings || {}) };
    this.giaBytes = rec.giaBytes ? new Uint8Array(rec.giaBytes) : null;
    this.giaName = rec.giaName || null;
    this.projectId = rec.id || rec.projectId || null;
    this.projectName = rec.name || rec.projectName || '';
    this.createdAt = rec.createdAt || null;
    this.importInfo = null;
    this.selection = new Set(); this.active = null; this.selectedKeys = new Set(); this.playing = false;
    this.applyOutlinerState(rec.ui);
    this.resetTransientState();
    this._committedProjectJson = null;
    this.history.reset(this.snapshotState());
    this.invalidate();
    this.dirty = dirty;
    this.emit('dirty');
    this.emit('change', { label: 'open' });
    this.emit('selection');
    this.emit('time');
    this.scheduleSave();
  }
  async renameLocal(id, name) {
    const rec = await getProject(id);
    if (!rec || !name) return false;
    rec.name = name; rec.modifiedAt = Date.now();
    try { await putProject(rec); } catch (e) { toast(t('toast.saveFailed', { err: e.message }), 'error'); return false; }
    if (this.projectId === id) { this.projectName = name; this.emit('dirty'); }
    this.emit('projects');
    return true;
  }
  async duplicateLocal(id) {
    const rec = await getProject(id);
    if (!rec) return null;
    const copy = { ...rec, id: newProjectId(), name: t('project.copyName', { name: rec.name }), createdAt: Date.now(), modifiedAt: Date.now() };
    try { await putProject(copy); } catch (e) { toast(isQuotaError(e) ? t('toast.saveQuota') : t('toast.saveFailed', { err: e.message }), 'error'); return null; }
    this.emit('projects');
    return copy.id;
  }
  async deleteLocal(id) {
    await deleteProject(id);
    if (this.projectId === id) { this.projectId = null; this.createdAt = null; this.setDirty(true); this.emit('dirty'); }
    this.emit('projects');
  }
  // ---------- outliner disclosure ----------
  outlinerState() { return { expandedDecos: [...this.expandedDecos], collapsed: [...this.collapsed] }; }
  applyOutlinerState(ui) {
    this.expandedDecos = new Set(Array.isArray(ui?.expandedDecos) ? ui.expandedDecos : []);
    this.collapsed = new Set(Array.isArray(ui?.collapsed) ? ui.collapsed : []);
  }
  resetOutlinerState() { this.expandedDecos = new Set(); this.collapsed = new Set(); }
  // a row is "open" when its child nodes are shown and (if it has decorations) they are shown too
  isOutlinerOpen(node) {
    const decs = node.type === 'object' ? node.decorations?.length || 0 : 0;
    return !this.collapsed.has(node.id) && (decs === 0 || this.expandedDecos.has(node.id));
  }
  toggleOutliner(id) {
    const node = getNode(this.project, id);
    if (!node) return;
    if (this.isOutlinerOpen(node)) { this.collapsed.add(id); this.expandedDecos.delete(id); }
    else { this.collapsed.delete(id); if (node.type === 'object' && node.decorations?.length) this.expandedDecos.add(id); }
    this.emit('outliner');
    this.scheduleSave();
  }
  undo() { this.settleGizmo(); const s = this.history.undo(); if (s) this.applyState(s); }
  redo() { this.settleGizmo(); const s = this.history.redo(); if (s) this.applyState(s); }
  // Swap in a project snapshot without moving the playhead (time is not undoable).
  keepPlayheads(state) {
    const heads = new Map(this.project.clips.map((c) => [c.id, c.playhead || 0]));
    for (const c of state.clips) if (heads.has(c.id)) c.playhead = heads.get(c.id);
    return state;
  }
  applyState(state) {
    this.settleGizmo();
    this._reorient = null;
    const st = this.parseState(state);
    this.project = this.keepPlayheads(st.project);
    this._committedProjectJson = null;
    this.poseOverrides = new Map(st.overrides);
    this._overrideVer++;
    this.pruneSelection();
    this.invalidate();
    this.emit('overrides');
    this.emit('change', { label: 'undo' });
    this.scheduleSave();
  }
  pruneSelection() {
    for (const id of [...this.selection]) if (!getNode(this.project, id)) this.selection.delete(id);
    if (this.active && !getNode(this.project, this.active)) this.active = [...this.selection][0] || null;
    this.selectedKeys = new Set([...this.selectedKeys].filter((r) => this.keyExists(r)));
    if (!getClip(this.project, this.project.activeClipId)) this.project.activeClipId = this.project.clips[0]?.id || null;
  }

  // ---------- modes & tools ----------
  setMode(m) { if (this.mode === m) return; this.mode = m; document.body.dataset.mode = m; this.emit('mode', m); }
  setTool(tool) {
    if (tool === this.tool) return;
    if (tool !== 'select' && !this.availableTools().includes(tool)) {
      this.setHint(t(tool === 'scale' ? 'hint.scaleNeedsDisplay' : 'props.positionOnly'));
      return;
    }
    this.settleGizmo(); this.tool = tool; this.emit('tool');
  }

  // ---------- display model (visualization layer, editor-only) ----------
  // node.display = { pos, rot, scale }: a local offset applied to the object's
  // display geometry only (decorations / fallback boxes). It never touches the
  // object transform, keys, bones, devices or the exported file.
  setDisplayEdit(v) {
    v = !!v;
    if (v === this.displayEdit) return;
    this.settleGizmo();
    this.displayEdit = v;
    if (!v) { this.displaySel = new Set(); this.displayActive = null; }
    if (!v && this.tool === 'scale') this.tool = 'move';
    if (v && this.tool === 'select') this.tool = 'move';
    this.emit('tool');
    this.setHint(t(v ? 'hint.displayEditOn' : 'hint.displayEditOff'));
  }
  toggleDisplayEdit() { this.setDisplayEdit(!this.displayEdit); }
  // the object whose display model is being edited (active object in display-edit mode)
  displayEditNode() { const n = this.activeNode(); return this.displayEdit && n && n.type === 'object' ? n : null; }
  // world transform of the display geometry frame (object world ∘ display offset), with view offsets
  displayFrameWorld(id) {
    const n = getNode(this.project, id);
    const w = this.displayWorld().get(id);
    if (!n || !w) return null;
    const d = displayOf(n);
    return xf.compose(w, { pos: d.pos, rot: d.rot });
  }
  setDisplayTransform(id, patch, { commit = true, label = t('hist.display') } = {}) {
    const n = getNode(this.project, id);
    if (!n || n.type !== 'object') return;
    const d = displayOf(n);
    n.display = { pos: (patch.pos || d.pos).slice(), rot: quat.norm(patch.rot || d.rot), scale: (patch.scale || d.scale).map((s) => Math.max(1e-4, s)) };
    if (commit) this.commit(label); else this.transient();
  }
  // gizmo path: a world transform of the display frame → local display offset
  setDisplayWorld(id, worldT, opts = {}) {
    const w = this.displayWorld().get(id);
    if (!w) return;
    const local = xf.localOf(worldT, w);
    this.setDisplayTransform(id, { pos: local.pos, rot: local.rot }, opts);
  }
  resetDisplay(id) { const n = getNode(this.project, id); if (n?.type === 'object') { DP.resetDisplayAll(n); this.displaySel = new Set(); this.displayActive = null; this.commit(t('hist.displayReset')); this.emit('displaySel'); } }

  // ---------- display parts (see scene/display-parts.js) ----------
  displayParts(id) { const n = getNode(this.project, id); return n?.type === 'object' ? DP.displayParts(n) : []; }
  displayPart(id, partId) { const n = getNode(this.project, id); return n ? DP.displayPart(n, partId) : null; }
  // parts currently selected on the active object (stale ids dropped)
  selectedDisplayParts() {
    const n = this.displayEditNode();
    if (!n || !this.displaySel.size) return [];
    const parts = DP.displayParts(n);
    return [...this.displaySel].map((id) => parts.find((p) => p.id === id)).filter(Boolean);
  }
  selectDisplayParts(ids, mode = 'replace') {
    this.settleGizmo();
    ids = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (mode === 'replace') { this.displaySel = new Set(ids); this.displayActive = ids[ids.length - 1] || null; }
    else if (mode === 'add') { for (const id of ids) this.displaySel.add(id); this.displayActive = ids[ids.length - 1] || this.displayActive; }
    else if (mode === 'toggle') {
      for (const id of ids) { if (this.displaySel.has(id)) { this.displaySel.delete(id); if (this.displayActive === id) this.displayActive = [...this.displaySel].pop() || null; } else { this.displaySel.add(id); this.displayActive = id; } }
    }
    this.emit('displaySel');
  }
  // root frame (object world ∘ root offset, with view offsets) and root scale (zoom ⊙ root scale)
  displayRootScale(id) { const n = getNode(this.project, id); const d = displayOf(n); const z = n?.zoom || [1, 1, 1]; return [z[0] * d.scale[0], z[1] * d.scale[1], z[2] * d.scale[2]]; }
  partWorld(id, partId) {
    const part = this.displayPart(id, partId), frame = this.displayFrameWorld(id);
    return part && frame ? DP.partWorld(frame, this.displayRootScale(id), part) : null;
  }
  setPartTransform(id, partId, patch, { commit = true, label = t('hist.displayPart') } = {}) {
    const n = getNode(this.project, id);
    if (!n || !DP.setPartTransform(n, partId, patch)) return;
    if (commit) this.commit(label); else this.transient();
  }
  setPartWorld(id, partId, world, opts = {}) {
    const frame = this.displayFrameWorld(id);
    if (!frame) return;
    const local = DP.worldToPart(frame, this.displayRootScale(id), world);
    this.setPartTransform(id, partId, { pos: local.pos, rot: local.rot }, opts);
  }
  setPartProps(id, partId, props, label = t('hist.displayPartEdit')) { const n = getNode(this.project, id); if (n && DP.setPartProps(n, partId, props)) { this.commit(label); this.emit('displaySel'); } }
  renameDisplayPart(id, partId, name) { if (name?.trim()) this.setPartProps(id, partId, { name: name.trim() }, t('hist.displayRename')); }
  setPartHidden(id, partId, hidden) { this.setPartProps(id, partId, { hidden }, t('hist.displayVisibility')); }
  addDisplayPart(id, kind) {
    const n = getNode(this.project, id);
    if (!n || n.type !== 'object') return null;
    const part = DP.addCustomPart(n, kind, { scale: [0.2, 0.2, 0.2] });
    this.commit(t('hist.displayAddPart'));
    if (!this.displayEdit) this.setDisplayEdit(true);
    this.selectDisplayParts([part.id]);
    return part;
  }
  duplicateDisplayParts(id, partIds = null) {
    const n = getNode(this.project, id);
    const ids = partIds || [...this.displaySel];
    if (!n || !ids.length) return [];
    const out = DP.duplicateParts(n, ids);
    this.commit(t('hist.displayDuplicate'));
    this.selectDisplayParts(out);
    return out;
  }
  deleteDisplayParts(id, partIds = null) {
    const n = getNode(this.project, id);
    const ids = partIds || [...this.displaySel];
    if (!n || !ids.length) return null;
    const res = DP.deleteParts(n, ids);
    this.displaySel = new Set(); this.displayActive = null;
    this.commit(t('hist.displayDeletePart'));
    this.emit('displaySel');
    return res;
  }
  moveDisplayPart(id, partId, dir) { const n = getNode(this.project, id); if (n && DP.movePart(n, partId, dir)) { this.commit(t('hist.displayReorder')); this.emit('displaySel'); } }
  resetDisplayPart(id, partId) { const n = getNode(this.project, id); if (n && DP.resetPart(n, partId)) { this.commit(t('hist.displayResetPart')); this.emit('displaySel'); } }
  setSpace(s) { this.settleGizmo(); this.space = s; this.emit('tool'); }
  toggleSpace() { this.setSpace(this.space === 'world' ? 'local' : 'world'); }
  setSnap(patch) { Object.assign(this.snap, patch); updatePrefs({ snap: this.snap }); this.emit('tool'); }
  setWasd(v) { this.wasd = v; updatePrefs({ wasd: v }); this.emit('tool'); }
  setViewPref(patch) { Object.assign(this.view, patch); updatePrefs({ view: this.view }); this.emit('view'); this.emit('change', { transient: true, view: true }); }
  // ---------- scene size / Performance Mode ----------
  totalParts() {
    if (this._partsCountVer === this.changeVersion) return this._partsCount;
    let n = 0;
    for (const o of this.project.nodes) if (o.type === 'object') n += (o.decorations?.length || 0) + (o.display?.custom?.length || 0);
    this._partsCountVer = this.changeVersion; this._partsCount = n;
    return n;
  }
  perfActive() { return perfModeActive(this.view.perfMode || 'auto', this.totalParts()); }
  sceneStats() { return { objects: this.project.nodes.filter((n) => n.type === 'object').length, parts: this.totalParts(), perf: this.perfActive() }; }

  // ---------- Experimental Auto-Rig ----------
  proposeAutoRig(opts = {}) { return proposeRig(this.project, { objectIds: opts.objectIds || null, type: opts.type || 'auto', ik: !!opts.ik }); }
  setRigPreview(p) { this.rigPreview = p || null; this.emit('change', { transient: true }); }
  // Applies a proposal as ONE undo step; returns created ids. Existing bones are kept
  // (the dialog warns), objects are re-parented preserving their world transforms.
  applyAutoRig(proposal) {
    this.settleGizmo();
    const created = applyRig(this.project, proposal, { createNode, createConstraint, reparent });
    this.rigPreview = null;
    this.commit(t('hist.autoRig'));
    if (created.bones.length) this.select(created.bones[0]);
    return created;
  }
  // Every rotation representation of one node side by side (editor-only inspection):
  // rig rest, corrective offset, evaluated pose, world, exported placement and the
  // Motion Device waypoint the exporter would write for the current frame.
  transformDiagnostics(id) {
    const n = getNode(this.project, id);
    if (!n) return null;
    const E = (q) => quat.toEulerDeg(q);
    const local = this.currentLocal(id);
    const world = this.pose().world.get(id);
    const rest = restWorld(this.project).get(id);
    const base = exportPlacement(this.project).get(id);
    const out = {
      local: { pos: local.pos, rot: E(local.rot) },
      restLocal: { pos: n.pos, rot: E(n.rot) },
      correction: n.correction || [0, 0, 0],
      world: world ? { pos: world.pos, rot: E(world.rot) } : null,
      restWorld: rest ? { pos: rest.pos, rot: E(rest.rot) } : null,
      placement: base ? { pos: base.pos, rot: E(base.rot) } : null,
      restDiffersFromPlacement: !!(rest && base && (v3.dist(rest.pos, base.pos) > 1e-4 || quat.angle(rest.rot, base.rot) > 1e-4)),
    };
    if (n.type === 'object' && base && world) {
      const placementGame = displayQuatToGameEuler(base.rot), pg = displayToGamePos(base.pos);
      out.placementGame = { pos: [pg.x, pg.y, pg.z], rot: [placementGame.x, placementGame.y, placementGame.z] };
      const slot = exportSlots(this.project)[Math.max(0, initialSlotIndex(this.project))];
      const wp = toWaypoint({ pos: world.pos, rot: world.rot, duration: 0.03 }, base, slot?.outputYaw || 0, this.project.settings.relativeFrame || 'world', exportPivot(this.project));
      out.waypointGame = { pos: [wp.pos.x, wp.pos.y, wp.pos.z], rot: [wp.rot.x, wp.rot.y, wp.rot.z] };
    }
    return out;
  }
  // Transform tools valid for what is being edited right now: objects/bones get
  // Move + Rotate; display-model editing (root or parts) adds Scale.
  availableTools() {
    if (this.displayEditNode()) return ['move', 'rotate', 'scale'];
    // IK targets and poles only feed their position into the solver: Move only
    return isPositionOnly(this.activeNode()) ? ['move'] : ['move', 'rotate'];
  }
  // Space: cycle through the available transform tools (view state only — no
  // history entry, selection untouched, Local/World axes preserved).
  cycleTool() {
    const tools = this.availableTools();
    const i = tools.indexOf(this.tool);
    this.setTool(tools[(i + 1) % tools.length]);
    return this.tool;
  }
  toggleMoveRotate() { return this.cycleTool(); }
  // a tool that stopped being valid (Scale outside display editing) moves on to the next valid one
  ensureToolValid() { if (this.tool !== 'select' && !this.availableTools().includes(this.tool)) this.setTool(this.availableTools()[0]); }
  setRotateMode(m) { this.rotateMode = m === 'preserve' ? 'preserve' : 'normal'; updatePrefs({ rotateMode: this.rotateMode }); this.emit('tool'); }
  toggleRotateMode() { this.setRotateMode(this.rotateMode === 'preserve' ? 'normal' : 'preserve'); }

  // ---------- reorient: rotate a node, keep descendants fixed in world space ----------
  // Snapshot-based so a drag applies one exact delta from the drag-start state
  // (no accumulation): Δ = startLocal⁻¹ ∘ newLocal is post-multiplied onto the
  // node's base rotation and all of its rotation keys, and Δ⁻¹ is pre-multiplied
  // onto every direct child's base pos/rot and keys. Grandchildren are relative
  // to their own parent and need no change; corrections stay untouched.
  beginReorient(ids) {
    this.clearPoseOverrides(ids);
    const snap = new Map();
    const snapNode = (n) => ({ rot: quat.clone(n.rot), pos: v3.clone(n.pos) });
    const snapKeys = (nodeId) => {
      const out = [];
      for (const clip of this.project.clips) {
        const tr = clip.tracks[nodeId];
        if (!tr) continue;
        for (const ch of ['pos', 'rot']) for (const k of tr[ch]) out.push({ clip, ch, key: k, v: k.v.slice() });
      }
      return out;
    };
    for (const id of ids) {
      const node = getNode(this.project, id);
      if (!node) continue;
      const children = childrenOf(this.project, id);
      snap.set(id, {
        startLocal: quat.clone(this.currentLocal(id).rot),
        startWorld: quat.clone(this.pose().world.get(id).rot),
        self: snapNode(node), selfKeys: snapKeys(id),
        children: children.map((c) => ({ node: c, base: snapNode(c), keys: snapKeys(c.id) })),
      });
    }
    this._reorient = { snap, rebasedKeys: 0, clips: new Set() };
  }
  applyReorient(id, newLocalRot) {
    const R = this._reorient;
    const s = R?.snap.get(id);
    const node = getNode(this.project, id);
    if (!s || !node) return;
    // restore the drag-start state, then apply the exact delta once
    node.rot = quat.clone(s.self.rot); node.pos = v3.clone(s.self.pos);
    for (const k of s.selfKeys) k.key.v = k.v.slice();
    for (const c of s.children) { c.node.rot = quat.clone(c.base.rot); c.node.pos = v3.clone(c.base.pos); for (const k of c.keys) k.key.v = k.v.slice(); }
    const delta = quat.norm(quat.mul(quat.conj(s.startLocal), newLocalRot));
    const inv = quat.conj(delta);
    let rebased = 0;
    node.rot = quat.norm(quat.mul(node.rot, delta));
    for (const k of s.selfKeys) if (k.ch === 'rot') { k.key.v = quat.norm(quat.mul(k.key.v, delta)); rebased++; R.clips.add(k.clip.id); }
    // Children are rebased by the node's ACTUAL world-rotation change after
    // re-evaluation (IK may absorb part of the intended change); for plain
    // FK nodes this equals Δ exactly.
    this.invalidate();
    const wNew = this.pose().world.get(id);
    const actual = wNew ? quat.norm(quat.mul(quat.conj(s.startWorld), wNew.rot)) : delta;
    const invActual = quat.conj(actual);
    void inv;
    for (const c of s.children) {
      c.node.rot = quat.norm(quat.mul(invActual, c.node.rot));
      c.node.pos = quat.rotate(invActual, c.node.pos);
      for (const k of c.keys) {
        k.key.v = k.ch === 'rot' ? quat.norm(quat.mul(invActual, k.key.v)) : quat.rotate(invActual, k.key.v);
        rebased++; R.clips.add(k.clip.id);
      }
    }
    R.rebasedKeys = rebased;
    this.transient();
  }
  endReorient() {
    const R = this._reorient;
    this._reorient = null;
    if (!R) return;
    this.commit(t('hist.reorient'));
    if (R.rebasedKeys) toast(t('toast.reorientRebased', { n: R.rebasedKeys, m: R.clips.size }), 'warn', 4500);
    const ids = [...R.snap.keys()];
    if (this.project.constraints.some((k) => ids.includes(k.boneId) || ids.some((id) => chainBones(this.project, k).some((b) => b.id === id)))) toast(t('toast.reorientIK'), 'info', 3500);
  }
  reorientOnce(id, newLocalRot) { this.beginReorient([id]); this.applyReorient(id, newLocalRot); this.endReorient(); }
  setTimeDisplay(v) { this.timeDisplay = v; updatePrefs({ timeDisplay: v }); this.emit('time'); }
  setHint(s) { this.hint = s; this.emit('hint'); }

  // ---------- selection ----------
  select(ids, mode = 'replace') {
    // selection never depends on gizmo state: an unfinished transform is committed first
    this.settleGizmo();
    ids = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (mode === 'replace') { this.selection = new Set(ids); this.active = ids[ids.length - 1] || null; }
    else if (mode === 'add') { for (const id of ids) this.selection.add(id); this.active = ids[ids.length - 1] || this.active; }
    else if (mode === 'toggle') {
      for (const id of ids) { if (this.selection.has(id)) { this.selection.delete(id); if (this.active === id) this.active = [...this.selection].pop() || null; } else { this.selection.add(id); this.active = id; } }
    }
    this.pathPointSel = null;
    // part selection belongs to one owner object: changing the active object clears it
    if (this._displaySelOwner !== this.active) { this.displaySel = new Set(); this.displayActive = null; }
    this._displaySelOwner = this.active;
    this.ensureToolValid();
    this.emit('selection');
  }
  selectAll() { this.select(this.project.nodes.filter((n) => !n.hidden).map((n) => n.id)); }
  deselectAll() { this.select([]); this.selectedKeys = new Set(); this.emit('keys'); }
  setActive(id) { if (id && !this.selection.has(id)) this.selection.add(id); this.active = id; this.emit('selection'); }
  activeNode() { return this.active ? getNode(this.project, this.active) : null; }
  selectedNodes() { return [...this.selection].map((id) => getNode(this.project, id)).filter(Boolean); }

  // ---------- project / files ----------
  importGia(bytes, name) {
    let res;
    try { res = importGia(bytes, name); }
    catch (e) { console.error(e); toast(t('toast.importFailed', { err: e.message }), 'error', 4000); return false; }
    this.project = res.project;
    this.giaBytes = bytes;
    this.giaName = name;
    this.importInfo = res.info;
    this.selection = new Set(); this.active = null; this.selectedKeys = new Set();
    this.resetOutlinerState();
    this.playing = false;
    this.resetTransientState();
    this._committedProjectJson = null;
    this.history.reset(this.snapshotState());
    this.invalidate();
    // a freshly imported .gia is a new, unsaved local project
    this.projectId = null; this.projectName = this.defaultProjectName(); this.createdAt = null;
    this.setDirty(true);
    this.emit('change', { label: 'import' });
    this.emit('selection');
    this.scheduleSave();
    toast(t('toast.imported', { name, n: res.info.objects, d: res.info.decorations }));
    if (res.info.importedClips.length) toast(t('toast.importedClips', { n: res.info.importedClips.length }), 'info');
    return true;
  }
  newProject() {
    this.project = createProject();
    this.giaBytes = null; this.giaName = null; this.importInfo = null;
    this.selection = new Set(); this.active = null; this.selectedKeys = new Set(); this.playing = false;
    this.resetOutlinerState();
    this.projectId = null; this.projectName = ''; this.createdAt = null;
    this.resetTransientState();
    this._committedProjectJson = null;
    this.history.reset(this.snapshotState());
    this.invalidate();
    this.setDirty(false); this.emit('dirty');
    this.emit('change', { label: 'new' });
    this.emit('selection');
    clearRecovery();
  }
  restoreSession(rec) {
    if (!rec || !rec.project) return false;
    this.applyRecord({ ...rec, id: rec.projectId, name: rec.projectName }, { dirty: rec.dirty !== false });
    return true;
  }
  async clearSaved() { await clearRecovery(); }
  projectFileJSON() {
    const b64 = this.giaBytes ? btoa(String.fromCharCode(...this.giaBytes)) : null;
    return JSON.stringify({ app: 'miliastra-animator', version: 1, giaName: this.giaName, projectName: this.projectName, gia: b64, project: this.project, ui: this.outlinerState() });
  }
  openProjectFile(text) {
    const data = JSON.parse(text);
    if (data.app !== 'miliastra-animator' || !data.project) throw new Error('not a project file');
    this.project = { ...createProject(), ...data.project };
    this.project.settings = { ...createProject().settings, ...(data.project.settings || {}) };
    if (data.gia) { const bin = atob(data.gia); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); this.giaBytes = u8; } else this.giaBytes = null;
    this.giaName = data.giaName || null;
    this.selection = new Set(); this.active = null; this.selectedKeys = new Set(); this.playing = false;
    this.applyOutlinerState(data.ui);
    this.projectId = null; this.projectName = data.projectName || this.defaultProjectName(); this.createdAt = null;
    this.resetTransientState();
    this._committedProjectJson = null;
    this.history.reset(this.snapshotState());
    this.invalidate();
    this.setDirty(true);
    this.emit('change', { label: 'open' });
    this.emit('selection');
    this.scheduleSave();
  }

  // ---------- nodes ----------
  addBone(parentId = null) {
    const parent = parentId ? getNode(this.project, parentId) : null;
    let pos = [0, 0.5, 0];
    if (parent?.type === 'bone') pos = [0, parent.length, 0];
    else if (parent) pos = [0, 0, 0];
    else if (this.activeNode()) { const w = this.pose().world.get(this.active); pos = w ? v3.clone(w.pos) : pos; }
    const bone = createNode(this.project, 'bone', { parent: parent?.id || null, pos, length: parent?.type === 'bone' ? parent.length : 0.25 });
    if (parent) { /* keep tidy order: after parent's subtree */ reparent(this.project, bone.id, parent.id); bone.pos = pos; bone.rot = [0, 0, 0, 1]; }
    this.commit(t('hist.addBone'));
    this.select(bone.id);
    return bone;
  }
  // One bone per selected object, placed at the object's pivot and orientation;
  // the object becomes the bone's child with its world transform preserved.
  addBonesForSelected() {
    const world = this.pose().world;
    const rest = worldTransforms(this.project, null);
    const objects = this.selectedNodes().filter((n) => n.type === 'object');
    const skipped = [];
    const created = [];
    for (const obj of objects) {
      const parent = obj.parent ? getNode(this.project, obj.parent) : null;
      if (parent && parent.type === 'bone') { skipped.push(obj.name); continue; }
      const w = rest.get(obj.id) || world.get(obj.id);
      const bone = createNode(this.project, 'bone', { name: `${obj.name} Bone`, parent: obj.parent || null, length: 0.25 });
      setWorldTransform(this.project, bone, { pos: w.pos, rot: w.rot }, rest);
      reparent(this.project, bone.id, obj.parent || null);
      reparent(this.project, obj.id, bone.id);
      created.push(bone.id);
    }
    const nonObjects = this.selectedNodes().filter((n) => n.type !== 'object').map((n) => n.name);
    if (created.length) { this.commit(t('hist.addBones')); this.select(created); }
    toast(t('toast.bonesAdded', { n: created.length }), created.length ? 'success' : 'warn');
    const skippedAll = [...skipped, ...nonObjects];
    if (skippedAll.length) toast(t('toast.bonesSkipped', { n: skippedAll.length, names: skippedAll.slice(0, 4).join(', ') + (skippedAll.length > 4 ? '…' : '') }), 'warn', 4500);
    return created;
  }
  addNode(type, props = {}) {
    const node = createNode(this.project, type, props);
    if (props.atActive && this.active) { const w = this.pose().world.get(this.active); if (w) node.pos = v3.clone(w.pos); }
    this.commit(t('hist.add'));
    this.select(node.id);
    return node;
  }
  addProxy(shape) { return this.addNode('proxy', { shape, atActive: true, size: shape === 'sphere' ? [0.2, 0.2, 0.2] : [0.2, 0.2, 0.2] }); }
  deleteNodes(ids) {
    ids = ids.filter((id) => getNode(this.project, id));
    if (!ids.length) return;
    for (const id of ids) deleteNode(this.project, id);
    this.pruneSelection();
    this.commit(t('hist.delete'));
    this.emit('selection');
  }
  renameNode(id, name) {
    const n = getNode(this.project, id);
    if (!n || !name || n.name === name) return;
    n.name = name;
    this.commit(t('hist.rename'));
  }
  reparentNodes(ids, parentId) {
    let changed = false;
    for (const id of ids) { if (id === parentId) continue; if (reparent(this.project, id, parentId)) changed = true; }
    if (changed) this.commit(t('hist.parent'));
    return changed;
  }
  setNodeHidden(id, hidden) { const n = getNode(this.project, id); if (n) { n.hidden = hidden; this.commit(t('hist.visibility')); } }

  // ---------- transforms ----------
  // effective local pose (keyed value or base) of a node at the current time
  currentLocal(id) {
    const n = getNode(this.project, id);
    if (!n) return null;
    const p = this.pose().poses.get(id);
    return { pos: (p?.pos || n.pos).slice(), rot: (p?.rot || n.rot).slice() };
  }
  channelKeyed(id, channel) { const c = activeClip(this.project); const tr = c && track(c, id); return !!(tr && tr[channel].length); }
  hasKeyAt(id, channel, time = this.time) { const c = activeClip(this.project); const tr = c && track(c, id); return !!(tr && tr[channel].some((k) => Math.abs(k.t - time) < 1e-6)); }
  // Apply a new local pos/rot. With Auto Key (and a clip) this keys the channel;
  // otherwise it edits the base transform, or the key under the playhead.
  setNodeLocal(id, { pos, rot }, { commit = true, label = t('hist.transform'), forceKey = false } = {}) {
    const n = getNode(this.project, id);
    if (!n) return;
    if (this.playing) this.pause(); // interactive edits pause playback (playhead stays)
    // "Keep children" rotation mode: rig/rest edit that leaves descendants in place
    if (rot && this.rotateMode === 'preserve') {
      if (this._reorient?.snap.has(id)) { this.applyReorient(id, rot); if (commit) this.endReorient(); }
      else this.reorientOnce(id, rot);
      if (pos) this.setNodeLocal(id, { pos }, { commit, label, forceKey });
      return;
    }
    const clip = activeClip(this.project);
    const autoKey = this.project.settings.autoKey;
    let hinted = false;
    if (isPositionOnly(n)) rot = null; // rig controls never key or store a rotation
    for (const [ch, val] of [['pos', pos], ['rot', rot]]) {
      if (!val) continue;
      const keyed = clip && this.channelKeyed(id, ch);
      if (clip && (autoKey || forceKey || (keyed && this.hasKeyAt(id, ch)))) {
        insertKey(clip, id, ch, this.time, val, this.defaultInterp(clip, id, ch));
        this.clearPoseOverrides([id], [ch]);
      } else if (keyed) {
        // animated channel, no key at this frame, Auto Key off: temporary pose edit
        this.setPoseOverride(id, ch, val);
        if (!hinted) { hinted = true; this.setHint(t('hint.unkeyedPose')); }
      } else {
        n[ch] = val.slice();
      }
    }
    if (commit) this.commit(label); else this.transient();
  }
  defaultInterp(clip, id, ch) {
    const tr = track(clip, id);
    if (!tr || !tr[ch].length) return 'linear';
    let prev = null;
    for (const k of tr[ch]) if (k.t <= this.time) prev = k;
    return prev ? prev.i : tr[ch][0].i;
  }
  setNodeWorld(id, worldT, opts = {}) {
    const n = getNode(this.project, id);
    if (!n) return;
    const world = this.pose().world;
    const local = xf.localOf(worldT, parentWorld(this.project, n.parent, world));
    let rot = local.rot;
    if (n.type === 'object' && n.correction?.some((c) => c)) rot = quat.mul(rot, quat.conj(quat.fromEulerDeg(n.correction)));
    if (this.rotateMode === 'preserve' && this._reorient?.snap.has(id)) { this.setNodeLocal(id, { rot: quat.norm(rot) }, opts); return; }
    this.setNodeLocal(id, { pos: local.pos, rot: quat.norm(rot) }, opts);
  }
  setCorrection(id, euler) { const n = getNode(this.project, id); if (n?.type === 'object') { n.correction = euler.slice(); this.commit(t('hist.correction')); } }
  resetCorrection(id) { this.setCorrection(id, [0, 0, 0]); }
  resetTransform(id) {
    const n = getNode(this.project, id);
    if (!n) return;
    const pos = n.type === 'object' ? v3.clone(n.filePos) : [0, 0, 0];
    const rot = n.type === 'object' ? quat.clone(n.fileRot) : [0, 0, 0, 1];
    if (n.type === 'object' && n.parent) { /* file transform is world space */ this.setNodeWorld(id, { pos, rot }, { label: t('hist.reset') }); return; }
    this.setNodeLocal(id, { pos, rot }, { label: t('hist.reset') });
  }
  setNodeProps(id, patch, label = t('hist.edit')) { const n = getNode(this.project, id); if (!n) return; Object.assign(n, patch); this.commit(label); }
  setGlobalOffset(v) { this.project.settings.globalOffset = v.slice(); this.commit(t('hist.offset')); }
  setSetting(key, value, commit = true) { this.project.settings[key] = value; if (commit) this.commit(t('hist.setting')); else this.transient(); }

  // ---------- pose ----------
  get time() { const c = activeClip(this.project); return c ? c.playhead || 0 : 0; }
  pose() {
    const c = activeClip(this.project);
    const key = `${c?.id || ''}:${this.time}:${this._overrideVer}`;
    if (!this._pose || this._pose.key !== key) this._pose = { key, ...evaluatePose(this.project, c?.id || null, this.time, { overrides: this.activeOverrides() }) };
    return this._pose;
  }
  activeWaypath() { return this.project.waypaths.find((w) => w.id === this.project.activeWaypathId) || null; }
  // waypath offset at current time (display preview only)
  pathOffset() {
    const wp = this.activeWaypath();
    if (!wp || !wp.enabled || !this.project.settings.showWaypaths) return null;
    const c = activeClip(this.project);
    const tm = c ? this.time : 0;
    const e = evaluateWaypath(wp, tm);
    return { pos: e.pos, rot: wp.faceDirection ? quat.axisAngle([0, 1, 0], e.yaw) : [0, 0, 0, 1], pivot: this.scenePivot() };
  }
  scenePivot() {
    const roots = this.project.nodes.filter((n) => !n.parent && n.type === 'object');
    if (!roots.length) return [0, 0, 0];
    const off = this.project.settings.globalOffset || [0, 0, 0];
    let s = [0, 0, 0];
    for (const r of roots) s = v3.add(s, r.pos);
    s = v3.scale(s, 1 / roots.length);
    return [s[0] + off[0], 0, s[2] + off[2]];
  }
  applyPathOffset(w, off) {
    if (!off) return w;
    const rel = v3.sub(w.pos, off.pivot);
    return { pos: v3.add(v3.add(off.pivot, quat.rotate(off.rot, rel)), off.pos), rot: quat.mul(off.rot, w.rot) };
  }
  removePathOffset(w, off) {
    if (!off) return w;
    const p = v3.sub(w.pos, off.pos);
    const rel = quat.rotate(quat.conj(off.rot), v3.sub(p, off.pivot));
    return { pos: v3.add(off.pivot, rel), rot: quat.mul(quat.conj(off.rot), w.rot) };
  }
  // ---------- output rotation preview (view-only, session state) ----------
  // Shows the viewport exactly as export slot `i` will arrange the model: the
  // whole scene turned about the export pivot. Same transform as the exporter.
  setExportPreview(i) { this.exportPreviewSlot = i == null || i < 0 ? null : i; this.invalidate(); this.emit('preview'); this.emit('change', { transient: true }); }
  exportPreviewOffset() {
    if (this.exportPreviewSlot == null) return null;
    const slot = exportSlots(this.project)[this.exportPreviewSlot];
    if (!slot || !(slot.outputYaw % 360)) return null;
    return { pos: [0, 0, 0], rot: outputRotation(slot.outputYaw), pivot: exportPivot(this.project) };
  }
  // Every view-only offset applied on top of the evaluated pose, composed into
  // one rigid transform (output-rotation preview first, then the waypath preview).
  displayOffset() {
    const a = this.exportPreviewOffset(), b = this.pathOffset();
    if (!a) return b;
    if (!b) return a;
    // T(p) = pivot + R(p − pivot) + d ; compose b∘a keeping a's pivot
    const R = quat.norm(quat.mul(b.rot, a.rot));
    const Ta = this.applyPathOffset({ pos: a.pivot, rot: [0, 0, 0, 1] }, a); // a(pivot_a)
    const Tb = this.applyPathOffset({ pos: Ta.pos, rot: [0, 0, 0, 1] }, b); // b(a(pivot_a))
    return { pos: v3.sub(Tb.pos, a.pivot), rot: R, pivot: a.pivot };
  }
  displayWorld() {
    const world = this.pose().world;
    const off = this.displayOffset();
    if (!off) return world;
    const out = new Map();
    for (const [id, w] of world) out.set(id, this.applyPathOffset(w, off));
    return out;
  }

  // ---------- clips & playback ----------
  createClip(name) {
    const clip = createClip(this.project, uniqueClipName(this.project, name || t('clip.default')), 2);
    this.project.activeClipId = clip.id;
    if ((this.project.exportConfig.slots || []).length < MAX_DEVICES_PER_OBJECT) this.project.exportConfig.slots.push({ clipId: clip.id, name: clip.name, outputYaw: 0 });
    this.commit(t('hist.newClip'));
    this.emit('time');
    return clip;
  }
  deleteClip(id) {
    this.finishInteraction();
    this.clearPoseOverrides();
    this.project.clips = this.project.clips.filter((c) => c.id !== id);
    this.project.exportConfig.slots = (this.project.exportConfig.slots || []).filter((s) => s.clipId !== id);
    if (this.project.activeClipId === id) this.project.activeClipId = this.project.clips[0]?.id || null;
    this.selectedKeys = new Set();
    this.commit(t('hist.deleteClip'));
    this.emit('time');
  }
  renameClip(id, name) {
    const c = getClip(this.project, id);
    if (!c || !name) return;
    const old = c.name;
    c.name = uniqueClipName(this.project, name);
    for (const s of this.project.exportConfig.slots || []) if (s.clipId === id && (!s.name || s.name === old)) s.name = c.name;
    this.commit(t('hist.renameClip'));
  }
  duplicateClip(id) { const c = getClip(this.project, id); if (!c) return; const d = duplicateClip(this.project, c); this.project.activeClipId = d.id; this.commit(t('hist.duplicateClip')); this.emit('time'); return d; }
  setActiveClip(id) { this.finishInteraction(); this.clearPoseOverrides(); this.project.activeClipId = id; this.selectedKeys = new Set(); this.playing = false; this.invalidate(); this.commit(t('hist.switchClip')); this.emit('time'); }
  setClipProps(id, patch) { const c = getClip(this.project, id); if (!c) return; Object.assign(c, patch); if (patch.duration != null) c.playhead = Math.min(c.playhead, c.duration); this.commit(t('hist.clip')); this.emit('time'); }
  setTime(tm, emitChange = true) {
    const c = activeClip(this.project);
    if (!c) return;
    const next = Math.max(0, snapTime(tm));
    if (Math.abs(next - (c.playhead || 0)) > 1e-9) {
      // a frame change ends any transform first (its drag-start values belong to the old
      // frame) and discards unkeyed pose edits; timeline drags are the ones moving time
      if (this.interaction && !this.interaction.kind.startsWith('timeline')) this.finishInteraction();
      this.clearPoseOverrides();
    }
    c.playhead = next;
    this.invalidate();
    this.emit('time');
    if (emitChange) this.emit('change', { transient: true, time: true });
  }
  get fps() { return this.project.settings.fps || 30; }
  frameOf(tm) { return Math.round(tm * this.fps); }
  timeOfFrame(f) { return f / this.fps; }
  stepFrames(n) { this.pause(); this.setTime(this.timeOfFrame(this.frameOf(this.time) + n)); }
  play() { if (!activeClip(this.project)) return; this.playing = true; this.emit('play'); }
  pause() { this.playing = false; this.emit('play'); }
  togglePlay() { if (this.playing) this.pause(); else { const c = activeClip(this.project); if (c && this.time >= clipEnd(c) - 1e-6) c.playhead = 0; this.play(); } }
  tick(dt) {
    if (!this.playing) return;
    const c = activeClip(this.project);
    if (!c) { this.playing = false; return; }
    const end = Math.max(0.03, clipEnd(c));
    let tm = (c.playhead || 0) + dt;
    if (tm > end) { if (c.loop) tm = tm % end; else { tm = end; this.playing = false; this.emit('play'); } }
    c.playhead = tm;
    if (this.poseOverrides.size) this.clearPoseOverrides();
    this.invalidate();
    this.emit('time');
    this.emit('change', { transient: true, time: true });
  }

  // ---------- keyframes ----------
  insertKeyframe(ids = null, channels = ['pos', 'rot']) {
    const clip = activeClip(this.project);
    if (!clip) { toast(t('toast.noClip'), 'warn'); return; }
    ids = ids || [...this.selection];
    if (!ids.length) { toast(t('toast.noSelection'), 'warn'); return; }
    let n = 0;
    for (const id of ids) {
      const local = this.currentLocal(id);
      if (!local) continue;
      const chs = isPositionOnly(getNode(this.project, id)) ? channels.filter((c) => c === 'pos') : channels;
      for (const ch of chs) { insertKey(clip, id, ch, this.time, local[ch], this.defaultInterp(clip, id, ch)); n++; }
    }
    this.clearPoseOverrides(ids, channels);
    this.commit(t('hist.insertKey'));
    this.emit('keys');
    return n;
  }
  keyExists(ref) {
    const clip = activeClip(this.project);
    if (!clip) return false;
    const [nodeId, ch, ts] = ref.split('|');
    const tr = track(clip, nodeId);
    return !!(tr && tr[ch].some((k) => Math.abs(k.t - Number(ts)) < 1e-6));
  }
  selectKeys(refs, mode = 'replace') {
    if (mode === 'replace') this.selectedKeys = new Set(refs);
    else if (mode === 'add') for (const r of refs) this.selectedKeys.add(r);
    else for (const r of refs) { if (this.selectedKeys.has(r)) this.selectedKeys.delete(r); else this.selectedKeys.add(r); }
    this.emit('keys');
  }
  deleteSelectedKeys() { const c = activeClip(this.project); if (!c || !this.selectedKeys.size) return; deleteKeys(c, this.selectedKeys); this.selectedKeys = new Set(); this.clearPoseOverrides(); this.commit(t('hist.deleteKeys')); this.emit('keys'); }
  moveSelectedKeys(dt, commit = true) { const c = activeClip(this.project); if (!c || !this.selectedKeys.size) return; this.selectedKeys = moveKeys(c, this.selectedKeys, dt); if (commit) this.commit(t('hist.moveKeys')); else this.transient(); this.emit('keys'); }
  copySelectedKeys() { const c = activeClip(this.project); if (!c) return; this.keyClipboard = copyKeys(c, this.selectedKeys); if (this.keyClipboard) toast(t('toast.copiedKeys', { n: this.keyClipboard.length }), 'info', 1500); }
  pasteKeys() { const c = activeClip(this.project); if (!c || !this.keyClipboard) return; this.selectedKeys = pasteKeys(c, this.keyClipboard, this.time); this.commit(t('hist.pasteKeys')); this.emit('keys'); }
  duplicateSelectedKeys() {
    const c = activeClip(this.project); if (!c || !this.selectedKeys.size) return;
    const copy = copyKeys(c, this.selectedKeys);
    if (!copy) return;
    const t0 = Math.min(...[...this.selectedKeys].map((r) => Number(r.split('|')[2])));
    const span = Math.max(...copy.map((k) => k.t));
    this.selectedKeys = pasteKeys(c, copy, t0 + span + this.timeOfFrame(1));
    this.commit(t('hist.duplicateKeys')); this.emit('keys');
  }
  setKeyInterpolation(interp) { const c = activeClip(this.project); if (!c || !this.selectedKeys.size) return; setInterpolation(c, this.selectedKeys, interp); this.commit(t('hist.interp')); this.emit('keys'); }
  toggleAutoKey() { this.project.settings.autoKey = !this.project.settings.autoKey; this.commit(t('hist.autoKey')); this.emit('time'); }

  // ---------- rigging ----------
  addConstraint(boneId) {
    const bone = getNode(this.project, boneId);
    if (!bone || bone.type !== 'bone') return null;
    const world = this.pose().world;
    const tail = boneTail(bone, world);
    const target = createNode(this.project, 'target', { name: `${bone.name} IK`, pos: tail });
    const k = createConstraint(this.project, boneId, target.id, { name: `IK ${bone.name}`, chainLength: 2 });
    this.commit(t('hist.addIK'));
    this.select(target.id);
    return k;
  }
  addPoleFor(kid) {
    const k = this.project.constraints.find((c) => c.id === kid);
    if (!k) return;
    const bone = getNode(this.project, k.boneId);
    const world = this.pose().world;
    const w = world.get(bone.id);
    const pos = v3.add(w.pos, quat.rotate(w.rot, [0, 0, 0.5]));
    const pole = createNode(this.project, 'pole', { name: `${bone.name} Pole`, pos });
    k.poleId = pole.id;
    this.commit(t('hist.addPole'));
    this.select(pole.id);
    return pole;
  }
  updateConstraint(id, patch) { const k = this.project.constraints.find((c) => c.id === id); if (k) { Object.assign(k, patch); this.commit(t('hist.ik')); } }
  removeConstraint(id) { this.project.constraints = this.project.constraints.filter((c) => c.id !== id); this.commit(t('hist.removeIK')); }

  // ---------- waypaths ----------
  addWaypath(kind) { const wp = createWaypath(this.project, kind); this.project.activeWaypathId = wp.id; this.commit(t('hist.addPath')); return wp; }
  updateWaypath(id, patch, commit = true) { const wp = this.project.waypaths.find((w) => w.id === id); if (!wp) return; Object.assign(wp, patch); if (commit) this.commit(t('hist.path')); else this.transient(); }
  removeWaypath(id) { this.project.waypaths = this.project.waypaths.filter((w) => w.id !== id); if (this.project.activeWaypathId === id) this.project.activeWaypathId = this.project.waypaths[0]?.id || null; this.pathPointSel = null; this.commit(t('hist.removePath')); }
  setActiveWaypath(id) { this.project.activeWaypathId = id; this.pathPointSel = null; this.commit(t('hist.path')); }
  setPathPoint(id, index, pos, commit = true) { const wp = this.project.waypaths.find((w) => w.id === id); if (!wp || !wp.points[index]) return; wp.points[index] = pos.slice(); if (commit) this.commit(t('hist.path')); else this.transient(); }
  addPathPoint(id, afterIndex = null) {
    const wp = this.project.waypaths.find((w) => w.id === id); if (!wp) return;
    const i = afterIndex == null ? wp.points.length - 1 : afterIndex;
    const a = wp.points[i] || [0, 0, 0], b = wp.points[i + 1];
    const np = b ? v3.lerp(a, b, 0.5) : v3.add(a, wp.points.length > 1 ? v3.sub(a, wp.points[i - 1]) : [0, 0, 1]);
    wp.points.splice(i + 1, 0, np);
    this.pathPointSel = { wpId: id, index: i + 1 };
    this.commit(t('hist.path'));
  }
  removePathPoint(id, index) { const wp = this.project.waypaths.find((w) => w.id === id); if (!wp || wp.points.length <= 2) return; wp.points.splice(index, 1); this.pathPointSel = null; this.commit(t('hist.path')); }
  selectPathPoint(id, index) { this.pathPointSel = index == null ? null : { wpId: id, index }; this.selection = new Set(); this.active = null; this.emit('selection'); }
  // Bake the path into the active clip: a "Locomotion" bone becomes the parent
  // of every root node and receives the path's keys.
  bakeWaypath(id) {
    const wp = this.project.waypaths.find((w) => w.id === id);
    const clip = activeClip(this.project);
    if (!wp || !clip) { toast(t('toast.noClip'), 'warn'); return; }
    const roots = this.project.nodes.filter((n) => !n.parent);
    const pivot = this.scenePivot();
    const bone = createNode(this.project, 'bone', { name: t('path.locomotionBone'), pos: pivot, length: 0.3 });
    for (const r of roots) reparent(this.project, r.id, bone.id);
    for (const k of bakeWaypathKeys(wp)) {
      insertKey(clip, bone.id, 'pos', k.t, v3.add(pivot, k.pos), 'linear');
      insertKey(clip, bone.id, 'rot', k.t, k.rot, 'linear');
    }
    const dur = pathDuration(wp);
    if (dur > clip.duration) clip.duration = snapTime(dur);
    wp.enabled = false;
    this.commit(t('hist.bakePath'));
    this.select(bone.id);
    toast(t('toast.pathBaked'));
  }

  // ---------- export ----------
  get slots() { return this.project.exportConfig.slots || (this.project.exportConfig.slots = []); }
  addSlot(clipId) {
    if (this.slots.length >= MAX_DEVICES_PER_OBJECT) return;
    const clip = getClip(this.project, clipId) || this.project.clips[0];
    if (!clip) return;
    let name = clip.name;
    const used = new Set(this.slots.map((s) => s.name));
    let n = 2; while (used.has(name)) name = `${clip.name} ${n++}`;
    this.slots.push({ clipId: clip.id, name, outputYaw: 0 });
    this.commit(t('hist.slot'));
  }
  updateSlot(i, patch) { if (this.slots[i]) { Object.assign(this.slots[i], patch); this.commit(t('hist.slot')); } }
  removeSlot(i) { this.slots.splice(i, 1); if (this.project.exportConfig.initialSlot >= this.slots.length) this.project.exportConfig.initialSlot = 0; if (this.exportPreviewSlot != null && this.exportPreviewSlot >= this.slots.length) this.exportPreviewSlot = null; this.commit(t('hist.slot')); }
  moveSlot(i, dir) { const j = i + dir; if (j < 0 || j >= this.slots.length) return; const [s] = this.slots.splice(i, 1); this.slots.splice(j, 0, s); this.commit(t('hist.slot')); }
  setExportOption(patch) { Object.assign(this.project.exportConfig, patch); this.commit(t('hist.exportOption')); }
  validate() { return validateProject(this.project, this.giaBytes, this.importInfo); }
  exportFile() {
    const issues = this.validate();
    if (hasErrors(issues)) { toast(t('toast.exportBlocked'), 'error'); return null; }
    try {
      const { bytes, report } = exportGia(this.project, this.giaBytes);
      this.lastReport = report;
      const base = (this.giaName || 'model.gia').replace(/\.gia$/i, '');
      downloadBytes(bytes, `${base} Animated.gia`);
      toast(t('toast.exported', { n: report.parts.length, d: report.devices }));
      this.emit('export', report);
      return report;
    } catch (e) {
      console.error(e);
      toast(t('toast.exportFailed', { err: e.message }), 'error', 5000);
      return null;
    }
  }
}

export function downloadBytes(bytes, name, type = 'application/octet-stream') {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
