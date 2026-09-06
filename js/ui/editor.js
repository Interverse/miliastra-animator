// Central editor state and commands. Every mutation of the project goes
// through here so undo/redo, autosave and UI refresh stay consistent.
import { createProject, createNode, getNode, childrenOf, descendants, reparent, deleteNode, worldTransforms, setWorldTransform, localTransform, parentWorld, orderedNodes, isAncestor, boneTail, editableLocalFromWorld, rootNodes } from '../scene/scene.js';
import * as DP from '../scene/display-parts.js';
import { perfModeActive } from '../viewport/parts-plan.js';
import { proposeRig, applyRig } from '../rig/autorig.js';
import { v3, quat, xf } from '../core/math.js';
import { History } from '../core/history.js';
import { saveRecovery, clearRecovery, loadPrefs, savePrefs, updatePrefs, migrateNavPrefs, putProject, getProject, deleteProject, newProjectId, isQuotaError, PROJECT_SCHEMA } from '../core/persistence.js';
import { createClip, uniqueClipName, duplicateClip, getClip, activeClip, insertKey, keyRef, moveKeys, deleteKeys, copyKeys, pasteKeys, setInterpolation, clipEnd, track, evaluateKeys, snapTime } from '../anim/clips.js';
import { evaluatePose, rootMotionNode, clipHasRootMotion } from '../anim/evaluate.js';
import { createConstraint, chainBones } from '../anim/ik.js';
import { createWaypath, evaluateWaypath, bakeWaypathKeys, pathDuration } from '../anim/waypath.js';
import { importGia } from '../gia/gia-import.js';
import { exportGia, exportPlacement, exportSlots, initialSlotIndex, toWaypoint, exportPivot, outputRotation, buildExportPlan, pathLimitViolations, compressPlan, MAX_PATH_POINTS, MAX_OBJECT_SCALE, objectScaleViolations } from '../gia/gia-export.js';
import { simplifyPolyline } from '../anim/path-compress.js';
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
    let prefs = loadPrefs();
    // navigation preferences are versioned: existing users keep their effective orbit direction
    const mig = migrateNavPrefs(prefs);
    if (mig.changed) { prefs = mig.prefs; savePrefs(prefs); }
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
    this.hint = '';
    this._shownE = new Map();
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
  setPoseOverride(id, ch, val, e = null) {
    const clipId = this.project.activeClipId, t = this.time;
    const prev = this.poseOverrides.get(id);
    const o = prev && prev.clipId === clipId && Math.abs(prev.t - t) < 1e-6 ? { ...prev } : { clipId, t };
    o[ch] = val.slice();
    if (ch === 'rot') { if (e) o.rotE = e.slice(); else delete o.rotE; }
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
    this.beginProjectSwitch();
    this.project = { ...createProject(), ...rec.project };
    this.project.settings = { ...createProject().settings, ...(rec.project?.settings || {}) };
    this.giaBytes = rec.giaBytes ? new Uint8Array(rec.giaBytes) : null;
    this.giaName = rec.giaName || null;
    this.projectId = rec.id || rec.projectId || null;
    this.projectName = rec.name || rec.projectName || '';
    this.createdAt = rec.createdAt || null;
    this.lastSavedAt = rec.modifiedAt || null;
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
  undo() { this.finishInteraction(); const s = this.history.undo(); if (s) this.applyState(s); }
  redo() { this.finishInteraction(); const s = this.history.redo(); if (s) this.applyState(s); }
  // Swap in a project snapshot without moving the playhead (time is not undoable).
  keepPlayheads(state) {
    const heads = new Map(this.project.clips.map((c) => [c.id, c.playhead || 0]));
    for (const c of state.clips) if (heads.has(c.id)) c.playhead = heads.get(c.id);
    return state;
  }
  applyState(state) {
    // an unfinished drag must not keep references to objects the restored state may lack
    this.finishInteraction();
    this._reorient = null;
    this.rigPreview = null;
    const st = this.parseState(state);
    this.project = this.keepPlayheads(st.project);
    this._committedProjectJson = null;
    this.poseOverrides = new Map(st.overrides);
    this._overrideVer++;
    const selChanged = this.pruneSelection();
    this.invalidate();
    this.emit('overrides');
    this.emit('change', { label: 'undo' });
    if (selChanged) this.emit('selection');
    this.scheduleSave();
  }
  // Drop every selection / hover reference to entities that no longer exist. Returns true when something changed.
  pruneSelection() {
    let changed = false;
    for (const id of [...this.selection]) if (!getNode(this.project, id)) { this.selection.delete(id); changed = true; }
    if (this.active && !getNode(this.project, this.active)) { this.active = [...this.selection][0] || null; changed = true; }
    if (this._displaySelOwner && !getNode(this.project, this._displaySelOwner)) { this.displaySel = new Set(); this.displayActive = null; this._displaySelOwner = null; changed = true; }
    if (this.displayEdit && (!this.active || getNode(this.project, this.active)?.type !== 'object')) { this.displayEdit = false; changed = true; }
    if (this.pathPointSel) {
      const wp = this.project.waypaths.find((w) => w.id === this.pathPointSel.wpId);
      if (!wp || !wp.points?.[this.pathPointSel.index]) { this.pathPointSel = null; changed = true; }
    }
    if (this.exportPreviewSlot != null && !(this.project.exportSlots || this.project.export?.slots || [])[this.exportPreviewSlot]) this.exportPreviewSlot = null;
    this.selectedKeys = new Set([...this.selectedKeys].filter((r) => this.keyExists(r)));
    if (!getClip(this.project, this.project.activeClipId)) this.project.activeClipId = this.project.clips[0]?.id || null;
    return changed;
  }
  // First step of every project switch (New / Open / Recent / Import / Recover / Duplicate):
  // cancel the interaction that may still hold the old objects, stop playback, drop previews,
  // and tell the viewport to dispose the old project root before the new state appears.
  beginProjectSwitch() {
    this.cancelInteraction();
    this.playing = false;
    // export progress belongs to the project that produced it: a new/opened project starts
    // again at "not exported yet", so contextual hints and the Export panel's report cannot
    // describe the previous project
    this.lastReport = null;
    // every temporary preview ends with the project it belonged to
    this.rigPreview = null;
    this.exportPreviewSlot = null;
    this.orientPreview = null;
    this.scalePreview = null;
    this.exportPathPreview = null;
    this.emit('project', { phase: 'teardown' });
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
  proposeAutoRig(opts = {}) { return proposeRig(this.project, { objectIds: opts.objectIds || null, type: opts.type || 'auto', ik: !!opts.ik, pose: opts.pose || null }); }
  setRigPreview(p) { this.rigPreview = p || null; this.emit('change', { transient: true }); }
  // Applies a proposal as ONE undo step; returns created ids. Existing bones are kept
  // (the dialog warns), objects are re-parented preserving their world transforms.
  applyAutoRig(proposal) {
    this.settleGizmo();
    const created = applyRig(this.project, proposal, { createNode, createConstraint, reparent, setWorldTransform });
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

  // ---------- preserve child world transforms: move / rotate a node, keep descendants fixed ----------
  // Snapshot-based so a drag applies one exact delta from the drag-start state
  // (no accumulation). The node's own base pos/rot and keys receive the local
  // delta (Δrot post-multiplied, Δpos added in the parent frame). Descendants
  // are then rebased by the node's ACTUAL world change after re-evaluation
  // (M = newWorld⁻¹ ∘ startWorld, computed with full rigid transforms, never
  // Euler subtraction): every direct child's base pos/rot and keys become
  // M ∘ child, so child world = newWorld ∘ M ∘ child = startWorld ∘ child is
  // exactly what it was. Grandchildren are relative to their own parent and
  // need no change; attached objects (with their decorations) are children
  // like any other; corrections stay untouched. The hierarchy carries no
  // scale (object zoom scales only its own display), so no shear can arise.
  beginReorient(ids) {
    this.clearPoseOverrides(ids);
    const snap = new Map();
    const snapNode = (n) => ({ rot: quat.clone(n.rot), pos: v3.clone(n.pos), rotE: n.rotE ? n.rotE.slice() : null });
    const snapKeys = (nodeId) => {
      const out = [];
      for (const clip of this.project.clips) {
        const tr = clip.tracks[nodeId];
        if (!tr) continue;
        for (const ch of ['pos', 'rot']) for (const k of tr[ch]) out.push({ clip, ch, key: k, v: k.v.slice(), e: k.e ? k.e.slice() : null });
      }
      return out;
    };
    for (const id of ids) {
      const node = getNode(this.project, id);
      if (!node) continue;
      const children = childrenOf(this.project, id);
      snap.set(id, {
        startLocal: xf.clone(this.currentLocal(id)),
        startWorld: xf.clone(this.pose().world.get(id)),
        self: snapNode(node), selfKeys: snapKeys(id),
        // translating a node whose rotation is animated cannot be compensated exactly at every
        // frame (the descendants' offset depends on the node's rotation at each time)
        rotAnimated: this.project.clips.some((c) => c.tracks[id]?.rot.length > 1),
        children: children.map((c) => ({ node: c, base: snapNode(c), keys: snapKeys(c.id) })),
      });
    }
    this._reorient = { snap, rebasedKeys: 0, clips: new Set(), moved: new Set(), inexact: new Set() };
  }
  // newLocal: { pos?, rot? } (a bare quaternion is accepted for rotation-only calls)
  applyReorient(id, newLocal) {
    const R = this._reorient;
    const s = R?.snap.get(id);
    const node = getNode(this.project, id);
    if (!s || !node) return;
    if (Array.isArray(newLocal)) newLocal = { rot: newLocal };
    const newRot = newLocal.rot || s.startLocal.rot;
    const newPos = newLocal.pos || s.startLocal.pos;
    // restore the drag-start state, then apply the exact delta once
    node.rot = quat.clone(s.self.rot); node.pos = v3.clone(s.self.pos);
    for (const k of s.selfKeys) { k.key.v = k.v.slice(); if (k.e) k.key.e = k.e.slice(); else delete k.key.e; }
    for (const c of s.children) { c.node.rot = quat.clone(c.base.rot); c.node.pos = v3.clone(c.base.pos); for (const k of c.keys) { k.key.v = k.v.slice(); if (k.e) k.key.e = k.e.slice(); else delete k.key.e; } }
    const dRot = quat.norm(quat.mul(quat.conj(s.startLocal.rot), newRot));
    const dPos = v3.sub(newPos, s.startLocal.pos);
    let rebased = 0;
    node.rot = quat.norm(quat.mul(node.rot, dRot));
    node.pos = v3.add(node.pos, dPos);
    node.rotE = newLocal.rotE ? newLocal.rotE.slice() : quat.eulerNear(node.rot, s.self.rotE);
    for (const k of s.selfKeys) {
      k.key.v = k.ch === 'rot' ? quat.norm(quat.mul(k.key.v, dRot)) : v3.add(k.key.v, dPos);
      if (k.ch === 'rot' && k.key.e) k.key.e = quat.eulerNear(k.key.v, k.key.e);
      rebased++; R.clips.add(k.clip.id);
    }
    // Descendants are rebased by the node's ACTUAL world change after
    // re-evaluation (IK may absorb part of the intended change); for plain FK
    // nodes this equals the requested delta exactly.
    this.invalidate();
    const wNew = this.pose().world.get(id);
    const M = wNew ? xf.localOf(s.startWorld, wNew) : { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    for (const c of s.children) {
      const nl = xf.compose(M, { pos: c.node.pos, rot: c.node.rot });
      c.node.rot = nl.rot; c.node.pos = nl.pos;
      if (c.base.rotE) c.node.rotE = quat.eulerNear(c.node.rot, c.base.rotE);
      for (const k of c.keys) {
        k.key.v = k.ch === 'rot' ? quat.norm(quat.mul(M.rot, k.key.v)) : v3.add(M.pos, quat.rotate(M.rot, k.key.v));
        if (k.ch === 'rot' && k.key.e) k.key.e = quat.eulerNear(k.key.v, k.key.e);
        rebased++; R.clips.add(k.clip.id);
      }
    }
    R.rebasedKeys = rebased;
    if (v3.len(dPos) > 1e-12 || quat.angle(dRot, [0, 0, 0, 1]) > 1e-12) R.moved.add(id); else R.moved.delete(id);
    if (s.rotAnimated && v3.len(dPos) > 1e-12) R.inexact.add(id); else R.inexact.delete(id);
    this.transient();
  }
  endReorient() {
    const R = this._reorient;
    this._reorient = null;
    if (!R) return;
    this.commit(t('hist.reorient'));
    if (R.rebasedKeys) toast(t('toast.reorientRebased', { n: R.rebasedKeys, m: R.clips.size }), 'warn', 4500);
    const ids = [...R.snap.keys()];
    // a descendant driven by IK is re-solved from the new rest transform: say so instead of looking broken
    const ik = this.project.constraints.some((k) => k.enabled !== false && (ids.includes(k.boneId) || ids.some((id) => chainBones(this.project, k).some((b) => b.id === id || isAncestor(this.project, id, b.id)))));
    if (ik) toast(t('toast.reorientIK'), 'info', 3500);
    if (R.inexact.size) toast(t('toast.reorientInexact', { names: [...R.inexact].map((id) => getNode(this.project, id)?.name).join(', ') }), 'warn', 6000);
    this.lastRigEdit = { rebasedKeys: R.rebasedKeys, clips: R.clips.size, ik, moved: [...R.moved], inexact: [...R.inexact] };
  }
  // true when moving this node in preserve mode cannot keep descendants fixed at every frame
  moveRebaseInexact(id) { return this.project.clips.some((c) => c.tracks[id]?.rot.length > 1); }
  reorientOnce(id, newLocal) { this.beginReorient([id]); this.applyReorient(id, newLocal); this.endReorient(); }
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
    this.beginProjectSwitch();
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
    this.beginProjectSwitch();
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
    const b64 = this.giaBytes ? bytesToBase64(this.giaBytes) : null;
    return JSON.stringify({ app: 'miliastra-animator', version: 1, giaName: this.giaName, projectName: this.projectName, gia: b64, project: this.project, ui: this.outlinerState() });
  }
  openProjectFile(text) {
    const data = JSON.parse(text);
    if (data.app !== 'miliastra-animator' || !data.project) throw new Error('not a project file');
    this.beginProjectSwitch();
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
    const rot = (p?.rot || n.rot).slice();
    // authored angles when the pose carries them; otherwise (IK-driven bones, quaternion-only
    // imported keys) the representation nearest the angles shown last for this node, so the
    // inspector never flips to an equivalent ±180° triple while scrubbing or dragging
    const shown = this._shownE || (this._shownE = new Map());
    const prev = shown.get(id) || n.rotE || null;
    const rotE = p?.rot ? (p.rotE || quat.eulerNear(p.rot, prev)) : (n.rotE || quat.eulerNear(n.rot, prev));
    shown.set(id, rotE);
    return { pos: (p?.pos || n.pos).slice(), rot, rotE: rotE.slice() };
  }
  // Development diagnostics: where a displayed rotation comes from and what its alternatives are.
  rotationDiagnostics(id = this.active) {
    const n = getNode(this.project, id);
    if (!n) return null;
    const p = this.pose().poses.get(id);
    const q = (p?.rot || n.rot).slice();
    return {
      node: n.name, order: 'YXZ (X is the middle axis: canonical decomposition is singular at X = ±90°)',
      source: p?.rotE ? 'authored key/override angles' : p?.rot ? 'evaluated quaternion (IK / quaternion-only keys) → nearest to last shown' : n.rotE ? 'base authored angles' : 'base quaternion → nearest to last shown',
      quaternion: q, canonical: quat.toEulerDeg(q), alternatives: quat.eulerCandidates(q, this._shownE?.get(id) || null),
      authored: p?.rotE || (!p?.rot && n.rotE) || null, previousShown: this._shownE?.get(id) || null, shown: this.currentLocal(id).rotE, world: this.pose().world.get(id)?.rot,
    };
  }
  channelKeyed(id, channel) { const c = activeClip(this.project); const tr = c && track(c, id); return !!(tr && tr[channel].length); }
  hasKeyAt(id, channel, time = this.time) { const c = activeClip(this.project); const tr = c && track(c, id); return !!(tr && tr[channel].some((k) => Math.abs(k.t - time) < 1e-6)); }
  // Apply a new local pos/rot. With Auto Key (and a clip) this keys the channel;
  // otherwise it edits the base transform, or the key under the playhead.
  setNodeLocal(id, { pos, rot, rotE = null }, { commit = true, label = t('hist.transform'), forceKey = false } = {}) {
    const n = getNode(this.project, id);
    if (!n) return;
    if (this.playing) this.pause(); // interactive edits pause playback (playhead stays)
    // authored angles: typed values are kept verbatim (450°, -720° …); gizmo / world-space
    // edits unwrap the new orientation next to the previous angles so turns accumulate
    if (rot && !rotE) rotE = quat.eulerNear(rot, this.currentLocal(id).rotE).map((v) => Math.round(v * 1e9) / 1e9); // quaternion round-trip noise removed
    // Preserve child world transforms: a rig/rest edit (move and/or rotate) that leaves
    // every descendant in place and never creates keyframes
    if ((rot || pos) && this.rotateMode === 'preserve') {
      const local = { pos, rot: isPositionOnly(n) ? null : rot, rotE };
      if (this._reorient?.snap.has(id)) { this.applyReorient(id, local); if (commit) this.endReorient(); }
      else this.reorientOnce(id, local);
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
        insertKey(clip, id, ch, this.time, val, this.defaultInterp(clip, id, ch), ch === 'rot' ? rotE : null);
        this.clearPoseOverrides([id], [ch]);
      } else if (keyed) {
        // animated channel, no key at this frame, Auto Key off: temporary pose edit
        this.setPoseOverride(id, ch, val, ch === 'rot' ? rotE : null);
        if (!hinted) { hinted = true; this.setHint(t('hint.unkeyedPose')); }
      } else {
        n[ch] = val.slice();
        if (ch === 'rot') n.rotE = rotE.slice();
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
    const local = editableLocalFromWorld(this.project, n, worldT, world); // basis + correction stripped
    this.setNodeLocal(id, { pos: local.pos, rot: local.rot }, opts);
  }
  setCorrection(id, euler) { const n = getNode(this.project, id); if (n?.type === 'object') { n.correction = euler.slice(); this.commit(t('hist.correction')); } }
  resetCorrection(id) { this.setCorrection(id, [0, 0, 0]); }
  resetTransform(id) {
    const n = getNode(this.project, id);
    if (!n) return;
    const pos = n.type === 'object' ? v3.clone(n.filePos) : [0, 0, 0];
    const rot = n.type === 'object' ? quat.clone(n.fileRot) : [0, 0, 0, 1];
    if (n.type === 'object' && n.parent) { /* file transform is world space */ this.setNodeWorld(id, { pos, rot }, { label: t('hist.reset') }); return; }
    this.setNodeLocal(id, { pos, rot, rotE: n.type === 'object' ? null : [0, 0, 0] }, { label: t('hist.reset') });
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
    const offs = [this.orientPreviewOffset(), this.exportPreviewOffset(), this.pathOffset()].filter(Boolean);
    if (!offs.length) return null;
    // T(p) = pivot + R(p − pivot) + d ; compose b∘a keeping a's pivot
    return offs.reduce((a, b) => {
      const R = quat.norm(quat.mul(b.rot, a.rot));
      const Ta = this.applyPathOffset({ pos: a.pivot, rot: [0, 0, 0, 1] }, a); // a(pivot_a)
      const Tb = this.applyPathOffset({ pos: Ta.pos, rot: [0, 0, 0, 1] }, b); // b(a(pivot_a))
      return { pos: v3.sub(Tb.pos, a.pivot), rot: R, pivot: a.pivot };
    });
  }
  // Reorient Model preview: the whole assembly turned about the model pivot (view only).
  orientPreviewOffset() {
    if (!this.orientPreview) return null;
    return { pos: [0, 0, 0], rot: this.orientPreview, pivot: exportPivot(this.project) };
  }
  setOrientPreview(q) { this.orientPreview = q && quat.angle(q, [0, 0, 0, 1]) > 1e-9 ? quat.norm(q) : null; this.invalidate(); this.emit('change', { transient: true }); }

  // ---------- Reorient Model ----------
  // Turn the COMPLETE model (objects with their decorations, bones, IK targets and
  // poles, constraints, waypaths, animation keys) as one unit by R about the model
  // pivot (the global offset), then freeze the turn into the rest basis: root bones
  // absorb it in their frozen basis so their editable rotation values stay as they
  // were (typically 0), root objects take it into their placement. Internal shape,
  // spacing and rig relationships are untouched; every clip is rebased with
  // quaternion composition (its motion turns with the model), so exporting applies
  // the correction exactly once through the ordinary world transforms.
  reorientModel(R, { label = null } = {}) {
    R = quat.norm(R);
    if (quat.angle(R, [0, 0, 0, 1]) < 1e-9) return false;
    this.finishInteraction();
    this._reorient = null;
    this.setOrientPreview(null);
    this.clearPoseOverrides();
    const rotP = (p) => quat.rotate(R, p); // root-local space: the pivot is the origin (world = globalOffset + local)
    const roots = rootNodes(this.project);
    for (const n of roots) {
      if (n.type === 'bone') {
        const B = n.basis || { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
        n.basis = { pos: rotP(B.pos), rot: quat.norm(quat.mul(R, B.rot)) };
        n.pos = rotP(n.pos);
      } else {
        n.pos = rotP(n.pos);
        n.rot = quat.norm(quat.mul(R, n.rot));
        n.rotE = quat.eulerNear(n.rot, n.rotE);
        if (n.filePos) n.filePos = rotP(n.filePos);
        if (n.fileRot) n.fileRot = quat.norm(quat.mul(R, n.fileRot));
      }
      for (const clip of this.project.clips) {
        const tr = clip.tracks[n.id];
        if (!tr) continue;
        for (const k of tr.pos) k.v = rotP(k.v);
        if (n.type !== 'bone') for (const k of tr.rot) { k.v = quat.norm(quat.mul(R, k.v)); if (k.e) k.e = quat.eulerNear(k.v, k.e); }
      }
    }
    for (const wp of this.project.waypaths) {
      if (wp.direction) wp.direction = rotP(wp.direction);
      if (wp.points) wp.points = wp.points.map((p) => rotP(p));
    }
    this.invalidate();
    this.commit(label || t('hist.reorientModel'));
    return true;
  }
  // ---------- Scale Entire Model ----------
  // Uniform scale S of the complete model about the model pivot (the global offset), baked
  // into the editable state as if a temporary common root had been scaled and removed:
  // every local position (objects, bones, IK targets, poles), bone length, frozen basis
  // offset, the parent object's own scale (zoom), display root offset, proxy size, position
  // key, waypath and path distance is multiplied by S; rotations, rotation keys, timing and
  // constraint weights are untouched. Decorations are never rewritten: their transforms are
  // relative to the parent object and follow its scale in the game, so only the parent's
  // zoom changes (the exporter writes just that). Nothing remains to be applied again:
  // export, IK and retargeting simply see a model of the new size.
  scaleModel(S, { label = null } = {}) {
    if (!Number.isFinite(S) || S <= 0 || Math.abs(S - 1) < 1e-12) return false;
    this.finishInteraction();
    this._reorient = null;
    this.clearPoseOverrides();
    for (const n of this.project.nodes) {
      n.pos = v3.scale(n.pos, S);
      if (n.basis) n.basis = { pos: v3.scale(n.basis.pos, S), rot: n.basis.rot };
      if (n.type === 'bone') n.length = (n.length || 0.25) * S;
      if (n.type === 'object') {
        n.zoom = (n.zoom || [1, 1, 1]).map((z) => z * S);
        if (n.filePos) n.filePos = v3.scale(n.filePos, S);
        if (n.display?.pos) n.display.pos = v3.scale(n.display.pos, S); // display root offset lives outside the zoom
      }
      if (n.type === 'proxy' && n.size) n.size = n.size.map((v) => v * S);
      for (const clip of this.project.clips) {
        const tr = clip.tracks[n.id];
        if (tr) for (const k of tr.pos) k.v = v3.scale(k.v, S);
      }
    }
    for (const wp of this.project.waypaths) {
      if (wp.points) wp.points = wp.points.map((p) => v3.scale(p, S));
      if (wp.velocity != null) wp.velocity *= S; // distances scale, timing stays
      if (wp.distance != null) wp.distance *= S;
    }
    this.project.modelScale = +(((this.project.modelScale || 1) * S).toPrecision(12)); // diagnostics only, never re-applied
    this.invalidate();
    this.commit(label || t('hist.scaleModel'));
    return true;
  }
  // Objects whose scale would exceed the Miliastra limit after scaling by S (warn before committing).
  predictObjectScales(S) {
    return this.project.nodes.filter((n) => n.type === 'object').map((n) => { const z = (n.zoom || [1, 1, 1]).map((v) => Math.abs(v) * S); const value = Math.max(...z); return { nodeId: n.id, guid: n.guid, name: n.name, value, axes: ['X', 'Y', 'Z'].filter((_, i) => z[i] > MAX_OBJECT_SCALE + 1e-9), over: value > MAX_OBJECT_SCALE + 1e-9 }; });
  }
  objectScaleViolations() { return objectScaleViolations(this.project); }
  // size of the assembled model (world-space extent of object pivots), for the Scale dialog
  modelExtent() {
    const w = worldTransforms(this.project, null);
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const n of this.project.nodes) { if (n.type !== 'object') continue; const p = w.get(n.id)?.pos; if (!p) continue; min = min.map((v, i) => Math.min(v, p[i])); max = max.map((v, i) => Math.max(v, p[i])); }
    return Number.isFinite(min[0]) ? max.map((v, i) => v - min[i]) : [0, 0, 0];
  }
  // ---------- Root Motion (per clip, non-destructive) ----------
  clipHasRootMotion(clip) { return clipHasRootMotion(this.project, clip); }
  clipRootNode(clip) { return rootMotionNode(this.project, clip); }
  setClipRootMotion(id, on) {
    const c = getClip(this.project, id);
    if (!c) return;
    this.finishInteraction(); // a control being dragged is settled first; the gizmo rebinds to the re-evaluated pose
    this.clearPoseOverrides();
    c.rootMotion = !!on;
    this.invalidate();
    this.commit(t(on ? 'hist.rootMotionOn' : 'hist.rootMotionOff'));
    this.emit('time');
    this.emit('selection');
  }
  // IK targets / poles follow the clip's root motion unless world-locked (kept at their world position when Root Motion is off).
  setWorldLocked(id, locked) { const n = getNode(this.project, id); if (!n || !isPositionOnly(n)) return; if (locked) n.worldLocked = true; else delete n.worldLocked; this.invalidate(); this.commit(t('hist.worldLocked')); }
  displayWorld() {
    const world = this.pose().world;
    const off = this.displayOffset();
    const S = this.scalePreview;
    if (!off && !S) return world;
    const out = new Map();
    const piv = S ? exportPivot(this.project) : null;
    for (const [id, w] of world) {
      let v = w;
      if (S) v = { pos: v3.add(piv, v3.scale(v3.sub(v.pos, piv), S)), rot: v.rot }; // Scale Entire Model preview
      out.set(id, off ? this.applyPathOffset(v, off) : v);
    }
    return out;
  }
  // Scale Entire Model preview (view only): positions scale about the pivot here, sizes in the viewport.
  setScalePreview(S) { this.scalePreview = S && Number.isFinite(S) && S > 0 && Math.abs(S - 1) > 1e-9 ? S : null; this.invalidate(); this.emit('change', { transient: true }); }

  // ---------- clips & playback ----------
  // Create a new clip (works from the zero-animation state: nothing is derived from an
  // existing or active clip). Unnamed clips are "Animation 1", "Animation 2", …
  createClip(name) {
    this.finishInteraction();
    if (!Array.isArray(this.project.clips)) this.project.clips = [];
    let clipName;
    if (name) clipName = uniqueClipName(this.project, name);
    else { const base = t('clip.default'); const used = new Set(this.project.clips.map((c) => c.name)); let n = 1; while (used.has(`${base} ${n}`)) n++; clipName = `${base} ${n}`; }
    const clip = createClip(this.project, clipName, 2);
    clip.playhead = 0;
    this.project.activeClipId = clip.id;
    this.selectedKeys = new Set();
    this.playing = false;
    if (this.slots.length < MAX_DEVICES_PER_OBJECT) this.slots.push({ clipId: clip.id, name: clip.name, outputYaw: 0 });
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
      for (const ch of chs) { insertKey(clip, id, ch, this.time, local[ch], this.defaultInterp(clip, id, ch), ch === 'rot' ? local.rotE : null); n++; }
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
  // The full export plan (final path points per object and animation); null when nothing can be exported.
  exportPlan() {
    if (!this.giaBytes || !exportSlots(this.project).length) return null;
    try { return buildExportPlan(this.project, this.giaBytes); } catch (e) { console.error(e); return null; }
  }
  // Hook for the UI: given the plan and its over-limit devices, return { plan, remember } to export or null to cancel.
  resolvePathLimit = null;
  // Per-slot auto-compression (persisted, undoable). Applies on every export of that slot.
  setSlotCompression(indices, on) {
    let changed = false;
    for (const i of indices) if (this.slots[i] && !!this.slots[i].compress !== !!on) { this.slots[i].compress = !!on; changed = true; }
    if (changed) this.commit(t('hist.exportCompress'));
  }
  async exportFile() {
    const issues = this.validate();
    if (hasErrors(issues)) { toast(t('toast.exportBlocked'), 'error'); return null; }
    try {
      // 1-5: evaluate, bake, apply output rotation / per-slot compression → final points; 6: validate ≤ limit; 7: serialize
      let plan = buildExportPlan(this.project, this.giaBytes);
      const over = pathLimitViolations(plan, MAX_PATH_POINTS);
      const oversized = plan.scaleIssues || [];
      if (oversized.length) { toast(t('toast.exportObjectScale', { n: oversized.length, max: MAX_OBJECT_SCALE, names: oversized.slice(0, 3).map((o) => `${o.name} ${o.axes.join('/')} ${o.value.toFixed(2)}`).join(', ') }), 'error', 8000); this.select(oversized.map((o) => o.nodeId)); return null; }
      if (over.length) {
        if (!this.resolvePathLimit) { toast(t('toast.exportPathLimit', { n: over.length, max: MAX_PATH_POINTS }), 'error', 6000); return null; }
        const choice = await this.resolvePathLimit(plan, over);
        if (!choice) { this.setExportPathPreview(null); return null; } // cancel: the project is untouched
        plan = choice.plan;
        if (choice.remember) this.setSlotCompression([...new Set(over.map((o) => o.slotIndex))], true);
      }
      this.setExportPathPreview(null);
      const { bytes, report } = exportGia(this.project, this.giaBytes, { plan });
      this.lastReport = report;
      const base = (this.giaName || 'model.gia').replace(/\.gia$/i, '');
      downloadBytes(bytes, `${base} Animated.gia`);
      toast(t('toast.exported', { n: report.parts.length, d: report.devices }));
      this.emit('export', report);
      return report;
    } catch (e) {
      console.error(e);
      this.setExportPathPreview(null);
      toast(t('toast.exportFailed', { err: e.message }), 'error', 5000);
      return null;
    }
  }
  // Viewport preview of compressed export paths (world-space polylines); null clears it.
  setExportPathPreview(preview) { this.exportPathPreview = preview || null; this.emit('change', { transient: true }); }
  // ---------- Freeze Transform ----------
  // Redefine a bone's current transform as its new rest: the visible pose (and every
  // descendant, attached object and IK result) stays exactly where it is, while the
  // editable local values become 0 / identity. The old values are folded into node.basis
  // (position = basis.pos + local pos, rotation = basis.rot ∘ local rot); keys and unkeyed
  // pose edits are rebased with quaternion composition, so existing animation is visually
  // identical and freezing rotation never disturbs the position values.
  freezeTransform(id, { pos = true, rot = true } = {}) {
    const n = getNode(this.project, id);
    if (!n || n.type !== 'bone' || (!pos && !rot)) return null;
    this.finishInteraction();
    this._reorient = null;
    const cur = this.currentLocal(id); // what the panel shows right now (keyed value, override or base)
    const R = rot ? quat.clone(cur.rot) : [0, 0, 0, 1];
    const P = pos ? v3.clone(cur.pos) : [0, 0, 0];
    // already frozen at this pose: identity orientation, no offset AND canonical zero angles
    // (a bone showing 360° or 359.999999° is the identity too, yet must still be zeroed)
    const anglesZero = !rot || cur.rotE.every((a) => Math.abs(a) < 1e-6);
    if (quat.angle(R, [0, 0, 0, 1]) < 1e-12 && v3.len(P) < 1e-12 && anglesZero) return null;
    const B = n.basis || xf.identity();
    const nb = { pos: v3.add(B.pos, P), rot: quat.norm(quat.mul(B.rot, R)) };
    const Rinv = quat.conj(R);
    const mapPos = (p) => v3.sub(p, P);
    const mapRot = (q) => quat.norm(quat.mul(Rinv, q));
    // Authored angles after the freeze: the frozen orientation is the new canonical zero.
    // Every angle set is anchored at (previous angles − angles being frozen), so a key that
    // equals the frozen pose reads exactly (0, 0, 0) — never 360 or -0.000001 — while keys
    // elsewhere keep their turns relative to it (a 0→360 spin frozen at 360 becomes -360→0).
    const eF = rot ? cur.rotE : [0, 0, 0];
    const mapE = (q, e) => canonicalEuler(q, e ? v3.sub(e, eF) : null);
    n.pos = mapPos(n.pos); n.rot = mapRot(n.rot); n.rotE = mapE(n.rot, n.rotE || quat.toEulerDeg(quat.mul(R, n.rot)));
    let rebased = 0;
    for (const clip of this.project.clips) {
      const tr = clip.tracks[id];
      if (!tr) continue;
      for (const k of tr.pos) { k.v = mapPos(k.v); rebased++; }
      for (const k of tr.rot) { const eOld = k.e; k.v = mapRot(k.v); if (eOld) k.e = mapE(k.v, eOld); rebased++; }
    }
    const o = this.poseOverrides.get(id);
    if (o) { if (o.pos) o.pos = mapPos(o.pos); if (o.rot) { const eOld = o.rotE; o.rot = mapRot(o.rot); if (eOld) o.rotE = mapE(o.rot, eOld); } this._overrideVer++; }
    if (v3.len(nb.pos) < 1e-12 && quat.angle(nb.rot, [0, 0, 0, 1]) < 1e-12) delete n.basis; else n.basis = { pos: nb.pos, rot: quat.norm(nb.rot) };
    this.invalidate();
    this.commit(t(pos && rot ? 'hist.freeze' : rot ? 'hist.freezeRot' : 'hist.freezePos'));
    const ik = this.project.constraints.some((k) => k.enabled !== false && (k.boneId === id || chainBones(this.project, k).some((b) => b.id === id)));
    if (ik) toast(t('toast.freezeIK'), 'info', 3500);
    if (rebased) toast(t('toast.freezeRebased', { n: rebased }), 'info', 3500);
    this.lastFreeze = { rebased, ik };
    return this.lastFreeze;
  }
  // Fold the frozen basis back into the editable values (visible pose unchanged).
  unfreezeTransform(id) {
    const n = getNode(this.project, id);
    if (!n || !n.basis) return false;
    this.finishInteraction();
    this._reorient = null;
    const B = n.basis;
    const mapPos = (p) => v3.add(B.pos, p);
    const mapRot = (q) => quat.norm(quat.mul(B.rot, q));
    n.pos = mapPos(n.pos); n.rot = mapRot(n.rot); n.rotE = quat.eulerNear(n.rot, n.rotE);
    for (const clip of this.project.clips) {
      const tr = clip.tracks[id];
      if (!tr) continue;
      for (const k of tr.pos) k.v = mapPos(k.v);
      for (const k of tr.rot) { k.v = mapRot(k.v); if (k.e) k.e = quat.eulerNear(k.v, k.e); }
    }
    const o = this.poseOverrides.get(id);
    if (o) { if (o.pos) o.pos = mapPos(o.pos); if (o.rot) { o.rot = mapRot(o.rot); if (o.rotE) o.rotE = quat.eulerNear(o.rot, o.rotE); } this._overrideVer++; }
    delete n.basis;
    this.invalidate();
    this.commit(t('hist.unfreeze'));
    return true;
  }
  // Manual waypath simplification (undoable).
  simplifyWaypath(id, tolerance) {
    const wp = this.project.waypaths.find((w) => w.id === id);
    if (!wp || wp.kind !== 'manual') return null;
    const r = simplifyPolyline(wp.points, tolerance);
    if (r.after === wp.points.length) return r;
    wp.points = r.points;
    this.pathPointSel = null;
    this.commit(t('hist.simplifyPath'));
    this.emit('selection');
    return r;
  }
}

// Euler angles of q nearest to `anchor`, with floating-point dust removed: components within
// 1e-6° of a whole degree snap to it, and an orientation that IS the identity with an anchor at
// (or within noise of) zero becomes exactly [0, 0, 0]. Used for freeze / rest zeroing only — it
// never touches authored animation values such as 720°.
export function canonicalEuler(q, anchor = null) {
  const e = quat.eulerNear(q, anchor).map((v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-6 ? r : v; }).map((v) => (v === 0 ? 0 : v));
  const identity = quat.angle(q, [0, 0, 0, 1]) < 1e-7;
  if (identity && (!anchor || anchor.every((a) => Math.abs(a) < 1e-4))) return [0, 0, 0];
  return e;
}

// A .gia is megabytes: String.fromCharCode(...bytes) overflows the call stack, so encode in chunks.
function bytesToBase64(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  return btoa(s);
}

export function downloadBytes(bytes, name, type = 'application/octet-stream') {
  if (typeof document === 'undefined') return; // headless (tests): nothing to download to
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
