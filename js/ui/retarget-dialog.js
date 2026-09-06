// Import Animation / Retarget: file → clips → mapping → preview → apply (one undo step).
import { t } from '../i18n/i18n.js';
import { h, button, btnRow, hint, selectInput, checkbox, numInput, textInput } from './dom.js';
import { customDialog, toast, textPrompt } from './dialogs.js';
import { loadAnimationFile, ACCEPT, FORMATS } from '../retarget/anim-import.js';
import { autoMap, mappingIssues, skeletonSignature, roleMappingFromIds, mappingFromRoles, ROLES } from '../retarget/bone-map.js';
import { retargetClip, validateRetarget, detectRootMotion, TOLERANCES, ROOT_MODES } from '../retarget/retarget.js';
import { loadPrefs, updatePrefs } from '../core/persistence.js';
import { getNode } from '../scene/scene.js';
import { modelForward, sourceForward, yawBetween, yawQuat, EDITOR_FORWARD } from '../anim/orient.js';
import { hint as hintEl } from './dom.js';

const PRESET_KEY = 'retargetPresets';
const presets = () => loadPrefs()[PRESET_KEY] || {};
const savePreset = (name, sig, roleMap) => { const all = presets(); all[sig] = { name, roleMap, savedAt: Date.now() }; updatePrefs({ [PRESET_KEY]: all }); };

export async function showRetargetDialog(editor, file = null) {
  const targetBones = editor.project.nodes.filter((n) => n.type === 'bone');
  if (!targetBones.length) { toast(t('retarget.needRig'), 'warn', 4000); return; }
  if (!file) {
    file = await pickFile();
    if (!file) return;
  }
  // ---------- parse ----------
  let src;
  const progress = toast(t('retarget.parsing', { name: file.name }), 'info', 60000);
  try {
    src = await loadAnimationFile(file, { onProgress: () => {} });
  } catch (e) {
    progress?.remove?.();
    const msg = String(e.message || e);
    if (msg === 'unityMuscle') toast(t('retarget.err.unityMuscle'), 'error', 9000);
    else if (msg.startsWith('unsupported:')) toast(t('retarget.err.unsupported', { ext: msg.split(':')[1], formats: Object.values(FORMATS).map((f) => f.label).join(', ') }), 'error', 8000);
    else if (msg.startsWith('browserOnly')) toast(t('retarget.err.browserOnly'), 'error', 6000);
    else toast(t('retarget.err.parse', { err: msg.slice(0, 120) }), 'error', 8000);
    console.error(e);
    return;
  }
  progress?.remove?.();
  if (!src.clips.length) { toast(t('retarget.err.noClips'), 'warn', 6000); return; }
  if (!src.bones.length) { toast(t('retarget.err.noBones'), 'warn', 6000); return; }

  // ---------- state ----------
  const tb = targetBones.map((b) => ({ id: b.id, name: b.name, parent: b.parent, depth: depthOf(editor.project, b) }));
  const sig = skeletonSignature(src.bones);
  const auto = autoMap(src.bones, tb, { humanoidMap: src.humanoidMap });
  let mapping = { ...auto.mapping };
  const roles = { ...auto.roles };
  const targetRoles = auto.targetRoles;
  const preset = presets()[sig];
  if (preset) { mapping = mappingFromRoles(preset.roleMap, targetRoles, src.bones); for (const [tid] of Object.entries(mapping)) if (!roles[tid]) roles[tid] = Object.entries(targetRoles).find(([, id]) => id === tid)?.[0] || null; }
  // Forward-direction check: an imported skeleton facing +Z driving a rig that faces
  // sideways would twist every bone; offer to reorient the whole model first.
  const srcFwd = sourceForward(src, auto.sourceRoles), tgtFwd = modelForward(editor.project);
  if (srcFwd && tgtFwd) {
    const yaw = yawBetween(tgtFwd.heading, srcFwd.heading);
    if (Math.abs(yaw) > 30) {
      const body0 = h('div', { class: 'limit' });
      body0.append(hintEl(t('orient.mismatch', { src: srcFwd.name, model: tgtFwd.name, deg: Math.round(yaw) }), 'warn'));
      body0.append(hintEl(t('orient.mismatchHint')));
      const choice = await customDialog({ title: t('orient.mismatchTitle'), body: body0, buttons: [
        { label: t('btn.cancel'), value: () => 'cancel' },
        { label: t('orient.continueAnyway'), value: () => 'skip' },
        { label: t('orient.reorientNow', { deg: Math.round(yaw) }), primary: true, value: () => 'reorient' },
      ] });
      if (choice === 'cancel' || choice === null) return;
      if (choice === 'reorient') { editor.reorientModel(yawQuat(yaw), { label: t('hist.reorientModel') }); toast(t('orient.applied', { deg: Math.round(yaw), fwd: EDITOR_FORWARD }), 'success', 4000); }
    }
  }
  const clipSel = src.clips.map((c, i) => ({ clip: c, use: i === 0, name: c.name }));
  const hipsSi = auto.sourceRoles.hips;
  const rootInfo = detectRootMotion(src, src.clips[0], hipsSi);
  const options = { rootMotion: rootInfo.present ? 'keep' : 'inPlace', scaleToHeight: true, tolerance: 'normal', ik: editor.project.constraints.some((k) => k.enabled), loop: false };
  let previewClipId = null, previewing = false, applying = false;
  const restoreProject = () => { if (previewClipId) { editor.pause(); editor.restoreCommitted(); previewClipId = null; } };

  // ---------- UI ----------
  const body = h('div', { class: 'retarget' });
  const info = h('div');
  const clipsEl = h('div', { class: 'retarget-clips' });
  const optsEl = h('div');
  const mapEl = h('div', { class: 'retarget-map' });
  const warnEl = h('div');
  const previewEl = h('div', { class: 'retarget-preview' });
  body.append(h('div', { class: 'hint' }, t('retarget.intro')), info, h('div', { class: 'subhead-inline', text: t('retarget.clips') }), clipsEl, h('div', { class: 'subhead-inline', text: t('retarget.options') }), optsEl, h('div', { class: 'subhead-inline', text: t('retarget.mapping') }), mapEl, warnEl, h('div', { class: 'subhead-inline', text: t('retarget.preview') }), previewEl);

  const renderInfo = () => {
    info.innerHTML = '';
    info.append(h('div', { class: 'stat-grid' },
      h('span', { class: 'k', text: t('retarget.file') }), h('span', { class: 'v', text: `${src.name} · ${FORMATS[src.format]?.label || src.format}` }),
      h('span', { class: 'k', text: t('retarget.sourceRig') }), h('span', { class: 'v', text: t('retarget.sourceRigInfo', { bones: src.bones.length, height: src.height.toFixed(2), unit: src.unitScale === 1 ? 'm' : src.unitScale === 0.01 ? 'cm' : '×' + src.unitScale }) }),
      h('span', { class: 'k', text: t('retarget.target') }), h('span', { class: 'v', text: t('retarget.targetInfo', { name: editor.projectName || editor.defaultProjectName(), bones: targetBones.length }) }),
    ));
    if (src.meshes) info.append(hint(t('retarget.meshIgnored', { n: src.meshes })));
    if (src.humanoidMap) info.append(hint(t('retarget.vrmMap')));
    if (preset) info.append(hint(t('retarget.presetLoaded', { name: preset.name })));
  };
  const renderClips = () => {
    clipsEl.innerHTML = '';
    for (const c of clipSel) {
      const row = h('div', { class: 'retarget-clip-row' });
      const cb = h('input', { type: 'checkbox', checked: c.use });
      cb.addEventListener('change', () => { c.use = cb.checked; });
      const name = h('input', { type: 'text', value: c.name });
      name.addEventListener('change', () => { c.name = name.value.trim() || c.clip.name; });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      row.append(cb, name, h('span', { class: 'k', text: t('retarget.clipInfo', { dur: c.clip.duration.toFixed(2), keys: c.clip.keyCount, fps: Math.round(c.clip.sampleRate) || '—' }) }));
      clipsEl.append(row);
    }
  };
  const renderOptions = () => {
    optsEl.innerHTML = '';
    optsEl.append(h('div', { class: 'row' }, h('span', { class: 'label', text: t('retarget.rootMotion') }), selectInput(ROOT_MODES.map((m) => ({ value: m, label: t('retarget.root.' + m) })), options.rootMotion, (v) => { options.rootMotion = v; })));
    optsEl.append(hint(rootInfo.present ? t('retarget.rootDetected', { d: rootInfo.distance.toFixed(2) }) : t('retarget.rootNone')));
    optsEl.append(checkbox(t('retarget.scaleToHeight'), options.scaleToHeight, (v) => { options.scaleToHeight = v; }, t('tip.retarget.scaleToHeight')));
    optsEl.append(h('div', { class: 'row' }, h('span', { class: 'label', text: t('retarget.tolerance') }), selectInput(Object.keys(TOLERANCES).map((k) => ({ value: k, label: t('retarget.tol.' + k) })), options.tolerance, (v) => { options.tolerance = v; })));
    if (editor.project.constraints.length) optsEl.append(checkbox(t('retarget.ik'), options.ik, (v) => { options.ik = v; }, t('tip.retarget.ik')));
    optsEl.append(checkbox(t('retarget.loop'), options.loop, (v) => { options.loop = v; }));
  };
  const renderMap = () => {
    mapEl.innerHTML = '';
    const srcOpts = [{ value: '', label: '—' }, ...src.bones.map((b) => ({ value: String(b.index), label: '  '.repeat(Math.min(6, b.depth)) + b.name }))];
    const table = h('div', { class: 'retarget-table' });
    const rows = tb.slice().sort((a, b) => (roles[a.id] ? ROLES.indexOf(roles[a.id]) : 99) - (roles[b.id] ? ROLES.indexOf(roles[b.id]) : 99) || a.depth - b.depth);
    for (const b of rows) {
      const role = roles[b.id] || Object.entries(targetRoles).find(([, id]) => id === b.id)?.[0] || null;
      const sel = selectInput(srcOpts, mapping[b.id] != null ? String(mapping[b.id]) : '', (v) => { if (v === '') delete mapping[b.id]; else mapping[b.id] = +v; if (role) roles[b.id] = role; renderWarnings(); });
      table.append(h('div', { class: 'retarget-row' + (mapping[b.id] == null && role && MAJOR(role) ? ' missing' : '') }, h('span', { class: 'name', text: b.name, title: role ? t('retarget.role', { role }) : '' }), h('span', { class: 'k', text: role ? t('role.' + role) : '' }), sel));
    }
    mapEl.append(table);
    mapEl.append(btnRow(
      button(t('retarget.autoMap'), () => { const a = autoMap(src.bones, tb, { humanoidMap: src.humanoidMap }); mapping = { ...a.mapping }; Object.assign(roles, a.roles); renderMap(); renderWarnings(); }),
      button(t('retarget.clearMap'), () => { mapping = {}; renderMap(); renderWarnings(); }),
      button(t('retarget.savePreset'), async () => { const name = await textPrompt({ title: t('retarget.savePreset'), label: t('retarget.presetName'), value: src.name.replace(/\.[^.]+$/, '') }); if (name) { savePreset(name, sig, roleMappingFromIds(mapping, targetRoles, src.bones)); toast(t('retarget.presetSaved'), 'success'); } }),
      button(t('retarget.loadPreset'), () => { const all = presets(); const keys = Object.keys(all); if (!keys.length) { toast(t('retarget.noPresets'), 'info'); return; } const p = all[sig] || all[keys[keys.length - 1]]; mapping = mappingFromRoles(p.roleMap, targetRoles, src.bones); renderMap(); renderWarnings(); toast(t('retarget.presetLoaded', { name: p.name }), 'info'); }),
    ));
  };
  const MAJOR = (role) => ['hips', 'spine', 'head', 'upperArm.L', 'forearm.L', 'upperArm.R', 'forearm.R', 'thigh.L', 'shin.L', 'thigh.R', 'shin.R'].includes(role);
  const renderWarnings = () => {
    warnEl.innerHTML = '';
    const clip = clipSel.find((c) => c.use)?.clip || src.clips[0];
    const ws = validateRetarget(editor.project, src, clip, mapping, roles);
    for (const w of ws) warnEl.append(hint(warnText(w), w.kind === 'nothingMapped' || w.kind === 'noHipsMapped' || w.kind === 'noTargetBones' ? 'err' : 'warn'));
    if (!ws.length) warnEl.append(hint(t('retarget.ok')));
  };
  const warnText = (w) => {
    switch (w.kind) {
      case 'duplicate': return t('retarget.warn.duplicate', { source: w.source, targets: w.targets.join(', ') });
      case 'unmappedMajor': return t('retarget.warn.unmappedMajor', { roles: w.roles.map((r) => t('role.' + r)).join(', ') });
      case 'targetMissing': return t('retarget.warn.targetMissing', { roles: w.roles.map((r) => t('role.' + r)).join(', ') });
      case 'highSampleRate': return t('retarget.warn.highRate', { rate: w.rate });
      case 'scaleAnomaly': return t('retarget.warn.scale', { h: w.height.toFixed(2) });
      case 'nanSamples': return t('retarget.warn.nan', { n: w.n });
      default: return t('retarget.warn.' + w.kind);
    }
  };
  // ---------- preview ----------
  let timeSlider, timeLabel, playBtn;
  const renderPreview = () => {
    previewEl.innerHTML = '';
    playBtn = button(previewing ? t('retarget.stop') : t('retarget.play'), () => togglePreview(), { cls: previewing ? 'mini primary-mini' : 'mini' });
    timeSlider = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: 0, style: 'flex:1' });
    timeSlider.addEventListener('input', () => { if (previewClipId) { editor.pause(); editor.setTime(parseFloat(timeSlider.value) * editor.project.clips.find((c) => c.id === previewClipId).duration); } });
    timeLabel = h('span', { class: 'k', text: '0.00 s' });
    previewEl.append(h('div', { class: 'row' }, playBtn, timeSlider, timeLabel));
    previewEl.append(hint(t('retarget.previewHint')));
  };
  const buildPreview = async () => {
    restoreProject();
    const c = clipSel.find((x) => x.use) || clipSel[0];
    const res = await retargetClip(editor.project, src, c.clip, mapping, roles, { ...options, name: '⟳ ' + c.name });
    previewClipId = res.clip.id;
    editor.project.activeClipId = res.clip.id;
    editor.invalidate(); editor.setTime(0); editor.emit('change', { transient: true }); editor.emit('time');
    return res;
  };
  const togglePreview = async () => {
    if (previewing) { editor.pause(); previewing = false; renderPreview(); return; }
    const res = await buildPreview();
    previewing = true; renderPreview();
    toast(t('retarget.previewStats', { keys: res.stats.keysAfter, from: res.stats.keysBefore, bones: res.stats.bones }), 'info', 3000);
    editor.play();
  };
  const timeListener = editor.on('time', () => { if (previewClipId && timeSlider) { const c = editor.project.clips.find((x) => x.id === previewClipId); if (c) { timeSlider.value = String(c.duration ? editor.time / c.duration : 0); timeLabel.textContent = editor.time.toFixed(2) + ' s'; } } });

  renderInfo(); renderClips(); renderOptions(); renderMap(); renderWarnings(); renderPreview();
  // A file dragged over the dialog replaces the source (Escape/backdrop are blocked while a
  // drag is in progress; a drag that leaves the window just resets the highlight).
  let droppedFile = null;
  const dropSetup = (dlg, finish) => {
    const on = (v) => body.classList.toggle('dragover', v);
    dlg.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); on(true); } });
    dlg.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; on(true); } });
    dlg.addEventListener('dragleave', (e) => { if (!dlg.contains(e.relatedTarget)) on(false); });
    dlg.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); on(false); const f = e.dataTransfer?.files?.[0]; if (f) { droppedFile = f; finish('drop'); } });
    window.addEventListener('blur', () => on(false));
  };
  const r = await customDialog({ title: t('retarget.title'), body, setup: dropSetup, buttons: [
    { label: t('btn.cancel'), value: () => 'cancel' },
    { label: t('retarget.apply'), primary: true, value: () => 'apply' },
  ] });
  if (r === 'drop' && droppedFile) { timeListener(); editor.pause(); restoreProject(); return showRetargetDialog(editor, droppedFile); }
  timeListener();
  editor.pause();
  if (r !== 'apply') { restoreProject(); return; }
  // ---------- apply: one undo step, all selected clips ----------
  restoreProject();
  const chosen = clipSel.filter((c) => c.use);
  if (!chosen.length) { toast(t('retarget.err.noClipSelected'), 'warn'); return; }
  applying = true;
  const added = [];
  let totalKeys = 0;
  for (const c of chosen) {
    const res = await retargetClip(editor.project, src, c.clip, mapping, roles, { ...options, name: c.name });
    added.push(res.clip); totalKeys += res.stats.keysAfter;
    if ((editor.project.exportConfig.slots || []).length < 5) editor.project.exportConfig.slots.push({ clipId: res.clip.id, name: res.clip.name, outputYaw: 0 });
  }
  editor.project.activeClipId = added[0].id;
  editor.project.retargets = editor.project.retargets || [];
  editor.project.retargets.push({ file: src.name, format: src.format, clips: chosen.map((c) => c.name), roleMap: roleMappingFromIds(mapping, targetRoles, src.bones), options: { ...options }, signature: sig, at: Date.now() });
  editor.invalidate();
  editor.commit(t('hist.retarget'));
  editor.setTime(0);
  editor.emit('time');
  toast(t('retarget.applied', { n: added.length, keys: totalKeys }), 'success', 5000);
}

function depthOf(project, b) { let d = 0, p = b.parent; while (p) { d++; p = getNode(project, p)?.parent; } return d; }
function pickFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: ACCEPT, style: 'display:none' });
    input.addEventListener('change', () => { const f = input.files[0]; input.remove(); resolve(f || null); });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => { if (document.body.contains(input)) { /* dialog still open */ } }, 0);
  });
}
