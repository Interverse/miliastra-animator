// One registry of user-facing commands. Menus and the command palette (Ctrl+Shift+P /
// the 🔍 button) are built from it, so every feature has a discoverable path and all
// surfaces run the same editor methods (one canonical state per setting).
import { t } from '../i18n/i18n.js';
import { activeClip } from '../anim/clips.js';
import { showAutoRigDialog } from './autorig-dialog.js';
import { FEATURES } from './feature-flags.js';
import { showRetargetDialog } from './retarget-dialog.js';
import { showReorientDialog } from './orient-dialog.js';
import { showScaleModelDialog } from './scale-dialog.js';
import { showShortcutsDialog, primaryKeyLabel } from './shortcuts.js';
import { showSettingsDialog } from './settings-dialog.js';
import { confirmDialog, messageDialog, toast } from './dialogs.js';

// ctx: { editor, viewport, timeline, tutorial }
export function buildCommands(ctx) {
  const { editor, viewport } = ctx;
  const bone = () => editor.activeNode()?.type === 'bone' ? editor.activeNode() : null;
  const clip = () => activeClip(editor.project);
  const go = (mode) => () => { editor.setMode(mode); };
  const cmds = [
    // ---- file ----
    { id: 'file.new', group: 'file', label: () => t('project.new'), keywords: 'new project reset', run: async () => { if (await (editor.guardUnsaved ? editor.guardUnsaved() : confirmDialog({ title: t('project.new'), message: t('project.newConfirm'), danger: true }))) editor.newProject(); } },
    { id: 'file.open', group: 'file', label: () => t('project.allProjects') + '…', keywords: 'open recent projects browser', run: () => editor.showProjectsDialog?.() },
    { id: 'file.save', group: 'file', label: () => t('project.saveLocal'), key: 'file.save', keywords: 'save project', run: () => editor.saveLocal() },
    { id: 'file.saveAs', group: 'file', label: () => t('project.saveAs') + '…', key: 'file.saveAs', keywords: 'save as copy', run: () => editor.saveLocal({ as: true }) },
    { id: 'file.importGia', group: 'file', label: () => t('cmd.importGia'), keywords: 'import gia model file open', run: () => editor.pickGiaFile?.() },
    { id: 'file.importAnim', group: 'file', label: () => t('retarget.button'), keywords: 'import animation fbx bvh gltf glb retarget mocap', run: () => showRetargetDialog(editor) },
    { id: 'file.exportGia', group: 'file', label: () => t('export.download'), keywords: 'export gia download motion device', run: () => { editor.setMode('export'); editor.exportFile(); } },
    { id: 'file.exportProject', group: 'file', label: () => t('project.save'), keywords: 'export project json backup', run: () => editor.exportProjectFile?.() },
    { id: 'file.importProject', group: 'file', label: () => t('project.open'), keywords: 'import project json', run: () => editor.pickProjectFile?.() },
    { id: 'file.clearSaved', group: 'file', label: () => t('project.clearSaved'), keywords: 'clear saved recovery storage', run: async () => { if (await confirmDialog({ title: t('project.clearSaved'), message: t('project.clearConfirm'), danger: true })) { await editor.clearSaved(); toast(t('toast.savedCleared'), 'info'); } } },
    // ---- edit ----
    { id: 'edit.undo', group: 'edit', label: () => t('sc.edit.undo'), key: 'edit.undo', keywords: 'undo', run: () => editor.undo() },
    { id: 'edit.redo', group: 'edit', label: () => t('sc.edit.redo'), key: 'edit.redo', keywords: 'redo', run: () => editor.redo() },
    { id: 'edit.copyKeys', group: 'edit', label: () => t('sc.anim.copyKeys'), key: 'anim.copyKeys', keywords: 'copy keyframes', run: () => editor.copySelectedKeys() },
    { id: 'edit.pasteKeys', group: 'edit', label: () => t('sc.anim.pasteKeys'), key: 'anim.pasteKeys', keywords: 'paste keyframes', run: () => editor.pasteKeys() },
    { id: 'edit.duplicateKeys', group: 'edit', label: () => t('sc.anim.duplicateKeys'), key: 'anim.duplicateKeys', keywords: 'duplicate keyframes', run: () => editor.duplicateSelectedKeys() },
    { id: 'edit.delete', group: 'edit', label: () => t('sc.edit.delete'), key: 'edit.delete', keywords: 'delete remove', run: () => { if (editor.selectedKeys.size && !editor.selection.size) editor.deleteSelectedKeys(); else editor.deleteSelected?.(); } },
    { id: 'edit.rename', group: 'edit', label: () => t('sc.edit.rename'), key: 'edit.rename', keywords: 'rename', run: () => editor.renameActive?.() },
    { id: 'edit.selectAll', group: 'edit', label: () => t('sc.edit.selectAll'), key: 'edit.selectAll', keywords: 'select all', run: () => editor.selectAll() },
    { id: 'edit.deselect', group: 'edit', label: () => t('sc.edit.deselect'), key: 'edit.deselect', keywords: 'deselect none', run: () => editor.deselectAll() },
    { id: 'edit.parent', group: 'edit', label: () => t('sc.edit.parent'), key: 'edit.parent', keywords: 'parent attach', run: () => { const ids = [...editor.selection].filter((id) => id !== editor.active); if (editor.active && ids.length) editor.reparentNodes(ids, editor.active); } },
    { id: 'edit.unparent', group: 'edit', label: () => t('sc.edit.unparent'), key: 'edit.unparent', keywords: 'unparent detach', run: () => editor.reparentNodes([...editor.selection], null) },
    // ---- model ----
    { id: 'model.orient', group: 'model', label: () => t('orient.button'), keywords: 'orientation forward reorient rotate model facing direction', run: () => showReorientDialog(editor) },
    { id: 'model.scale', group: 'model', label: () => t('scale.button'), keywords: 'scale entire model resize size', run: () => showScaleModelDialog(editor) },
    { id: 'model.workspace', group: 'model', label: () => t('cmd.goModel'), keywords: 'model workspace prepare offset display geometry', run: go('model') },
    // ---- rig ----
    ...(FEATURES.autoRig ? [{ id: 'rig.autorig', group: 'rig', label: () => t('autorig.button'), keywords: 'auto rig skeleton bones automatic humanoid quadruped', run: () => showAutoRigDialog(editor) }] : []),
    { id: 'rig.addBone', group: 'rig', label: () => t('add.bone'), keywords: 'add bone create', run: () => editor.addBone(editor.activeNode()?.type === 'bone' ? editor.active : null) },
    { id: 'rig.addBonesForSelected', group: 'rig', label: () => t('add.bonesForSelected'), keywords: 'bones selected objects', run: () => editor.addBonesForSelected() },
    { id: 'rig.addTarget', group: 'rig', label: () => t('add.target'), keywords: 'ik target add', run: () => editor.addNode('target', { atActive: true }) },
    { id: 'rig.addPole', group: 'rig', label: () => t('add.pole'), keywords: 'pole target add', run: () => editor.addNode('pole', { atActive: true }) },
    { id: 'rig.addIK', group: 'rig', label: () => t('rig.addIK'), keywords: 'ik constraint chain', when: () => !!bone(), run: () => editor.addConstraint(editor.active) },
    { id: 'rig.freezeRot', group: 'rig', label: () => t('props.freezeRot'), keywords: 'freeze rotation zero rest bind', when: () => !!bone(), run: () => editor.freezeTransform(editor.active, { pos: false, rot: true }) },
    { id: 'rig.freezePos', group: 'rig', label: () => t('props.freezePos'), keywords: 'freeze position rest', when: () => !!bone(), run: () => editor.freezeTransform(editor.active, { pos: true, rot: false }) },
    { id: 'rig.freezeBoth', group: 'rig', label: () => t('props.freezeBoth'), keywords: 'freeze transform rest', when: () => !!bone(), run: () => editor.freezeTransform(editor.active, { pos: true, rot: true }) },
    { id: 'rig.preserve', group: 'rig', label: () => t('rotmode.preserve'), keywords: 'preserve child world transforms keep children reorient', checked: () => editor.rotateMode === 'preserve', run: () => editor.toggleRotateMode() },
    { id: 'rig.workspace', group: 'rig', label: () => t('cmd.goRig'), keywords: 'rig workspace bones ik', run: go('rig') },
    // ---- animate ----
    { id: 'anim.new', group: 'anim', label: () => t('clip.new'), keywords: 'add animation new clip', run: () => { editor.setMode('animate'); editor.createClip(); } },
    { id: 'anim.duplicate', group: 'anim', label: () => t('clip.duplicate'), keywords: 'duplicate animation clip', when: () => !!clip(), run: () => editor.duplicateClip(clip().id) },
    { id: 'anim.insertKey', group: 'anim', label: () => t('sc.anim.insertKey'), key: 'anim.insertKey', keywords: 'insert keyframe key', run: () => editor.insertKeyframe() },
    { id: 'anim.autoKey', group: 'anim', label: () => t('sc.anim.autoKey'), key: 'anim.autoKey', keywords: 'auto key automatic keyframes', checked: () => !!editor.project.settings.autoKey, run: () => editor.toggleAutoKey() },
    { id: 'anim.play', group: 'anim', label: () => t('sc.anim.play'), key: 'anim.play', keywords: 'play pause preview', run: () => editor.togglePlay() },
    { id: 'anim.rootMotion', group: 'anim', label: () => t('cmd.rootMotion'), keywords: 'root motion in place travel', when: () => !!clip() && editor.clipHasRootMotion(clip()), checked: () => clip()?.rootMotion !== false, run: () => editor.setClipRootMotion(clip().id, clip().rootMotion === false) },
    { id: 'anim.frame', group: 'anim', label: () => t('graph.frameClip'), keywords: 'frame animation keyframes fit timeline zoom dope sheet', when: () => !!clip(), run: () => { editor.setMode('animate'); ctx.timeline?.frameAll(); } },
    { id: 'anim.graph', group: 'anim', label: () => t('graph.mode.graph'), keywords: 'graph editor curve editor fcurve tangents handles', checked: () => ctx.timeline?.mode === 'graph', run: () => { editor.setMode('animate'); ctx.timeline?.setMode(ctx.timeline.mode === 'graph' ? 'dope' : 'graph'); } },
    { id: 'anim.simplify', group: 'anim', label: () => t('graph.simplifyTitle'), keywords: 'simplify curves reduce keys keyframes dense imported baked', when: () => !!clip(), run: () => { editor.setMode('animate'); ctx.timeline?.setMode('graph'); ctx.timeline?.graph.simplifyDialog(); } },
    { id: 'anim.addPath', group: 'anim', label: () => t('path.addManual'), keywords: 'waypath path movement', run: () => editor.addWaypath('manual') },
    { id: 'anim.workspace', group: 'anim', label: () => t('cmd.goAnimate'), keywords: 'animate workspace timeline keyframes', run: go('animate') },
    // ---- export ----
    { id: 'export.workspace', group: 'export', label: () => t('cmd.goExport'), keywords: 'export workspace output rotation checklist validation path limit scale', run: go('export') },
    { id: 'export.addSlot', group: 'export', label: () => t('export.addAnimation'), keywords: 'export animation slot motion device', run: () => { editor.setMode('export'); if (editor.project.clips.length) editor.addSlot(clip()?.id || editor.project.clips[0].id); else editor.createClip(); } },
    // ---- view ----
    { id: 'view.frameSelected', group: 'view', label: () => t('view.frameSelected'), key: 'view.frameSelected', keywords: 'frame selected focus', run: () => viewport.frameSelected() },
    { id: 'view.frameAll', group: 'view', label: () => t('view.frameAll'), key: 'view.frameAll', keywords: 'frame all fit', run: () => viewport.frameAll() },
    { id: 'view.projection', group: 'view', label: () => t('view.toggleProjection'), key: 'view.projection', keywords: 'perspective orthographic camera', run: () => { viewport.cam.toggleProjection(); viewport.nav.syncBtn(); } },
    ...['front', 'back', 'right', 'left', 'top', 'bottom'].map((v) => ({ id: 'view.' + v, group: 'view', label: () => t('view.' + v), key: 'view.' + v, keywords: 'view camera ' + v, run: () => viewport.setView(v) })),
    { id: 'view.displayEdit', group: 'view', label: () => t('display.edit'), key: 'tool.displayEdit', keywords: 'edit display model parts proxies', checked: () => editor.displayEdit, run: () => editor.toggleDisplayEdit() },
    ...[['showGrid', 'display.grid'], ['showBones', 'display.bones'], ['showConstraints', 'display.constraints'], ['showProxies', 'display.proxies'], ['showDecorations', 'display.decorations'], ['showAxes', 'display.axes'], ['showPivots', 'display.pivots'], ['showWaypaths', 'display.waypaths']].map(([k, label]) => ({ id: 'view.' + k, group: 'display', label: () => t(label), keywords: 'show hide display ' + k, checked: () => editor.project.settings[k] !== false, run: () => editor.setSetting(k, editor.project.settings[k] === false) })),
    { id: 'view.perf', group: 'display', label: () => t('display.perf') + ': ' + t('display.perf' + { auto: 'Auto', on: 'On', off: 'Off' }[editor.view.perfMode || 'auto']), keywords: 'performance mode fast', run: () => { const m = editor.view.perfMode || 'auto'; editor.setViewPref({ perfMode: m === 'auto' ? 'on' : m === 'on' ? 'off' : 'auto' }); } },
    { id: 'view.validate', group: 'view', label: () => t('view.validate'), keywords: 'validate viewport diagnostics ghost', run: () => { const r = viewport.validate({ warn: true, afterSync: true }); toast(r.ok ? t('toast.viewportOk', { n: r.entities, s: r.sceneObjects }) : t('toast.viewportIssues', { n: r.issues.length, kinds: [...new Set(r.issues.map((i) => i.kind))].join(', ') }), r.ok ? 'success' : 'error', r.ok ? 3000 : 8000); } },
    // ---- help / settings ----
    { id: 'help.tutorial', group: 'help', label: () => t('tut.button'), keywords: 'getting started tour tutorial help', run: () => ctx.tutorial?.start?.() },
    { id: 'help.shortcuts', group: 'help', label: () => t('tip.shortcuts'), keywords: 'keyboard shortcuts keys bindings', run: () => showShortcutsDialog() },
    { id: 'help.controls', group: 'help', label: () => t('help.controls'), keywords: 'controls mouse navigation orbit pan zoom', run: () => messageDialog({ title: t('help.controls'), message: t('help.controlsText') }) },
    { id: 'help.about', group: 'help', label: () => t('help.about'), keywords: 'about version', run: () => messageDialog({ title: t('help.about'), message: t('help.aboutText') }) },
    { id: 'settings', group: 'help', label: () => t('settings.title') + '…', keywords: 'settings preferences options language navigation brightness', run: () => showSettingsDialog(editor) },
  ];
  for (const c of cmds) c.shortcut = () => (c.key ? primaryKeyLabel(c.key) : '');
  return cmds;
}
export const COMMAND_GROUPS = ['file', 'edit', 'model', 'rig', 'anim', 'export', 'view', 'display', 'help'];
