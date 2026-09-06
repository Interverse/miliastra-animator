// Right rail: Properties (transform inspector), Rigging & Constraints,
// Display, Waypaths.
import { t, onLangChange } from '../i18n/i18n.js';
import { h, row, numInput, vec3Row, textInput, selectInput, checkbox, button, btnRow, subhead, hint, empty, rerender, slider, fmt } from './dom.js';
import { confirmDialog, toast, showMenu } from './dialogs.js';
import { getNode, childrenOf } from '../scene/scene.js';
import { displayOf, hasDisplayOffset, isPositionOnly } from './editor.js';
import { hasPartEdits, PART_KINDS } from '../scene/display-parts.js';
import { showAutoRigDialog } from './autorig-dialog.js';
import { textPrompt } from './dialogs.js';
import { activeClip } from '../anim/clips.js';
import { quat, v3, normDeg } from '../core/math.js';
import { chainBones, constraintIssues } from '../anim/ik.js';
import { modelInfo } from '../scene/primitives.js';
import { primaryKeyLabel } from './shortcuts.js';
import { effectiveDirectional, pathDuration, pathLength } from '../anim/waypath.js';
import { showSimplifyPathDialog } from './export-dialogs.js';
import { showReorientDialog } from './orient-dialog.js';
import { showScaleModelDialog } from './scale-dialog.js';

export function initRightPanels(editor, viewport) {
  const bodies = {
    properties: document.querySelector('#panel-properties .panel-body'),
    rigging: document.querySelector('#panel-rigging .panel-body'),
    display: document.querySelector('#panel-display .panel-body'),
    waypaths: document.querySelector('#panel-waypaths .panel-body'),
  };
  const wpCount = document.querySelector('#panel-waypaths .count');

  const eulerOf = (q) => quat.toEulerDeg(q).map((a) => normDeg(a));
  const worldText = (w) => w ? t('props.world', { p: w.pos.map((x) => fmt(x, 3)).join(', '), r: eulerOf(w.rot).map((x) => fmt(x, 1)).join(', ') }) : '';
  let live = null;
  let brightnessInput = null;
  // Update the transform inputs in place during gizmo drags (no full re-render)
  function updateLive() {
    if (!live || editor.active !== live.nodeId) return;
    const local = editor.currentLocal(live.nodeId);
    if (!local) return;
    const set = (inputs, vals, prec) => inputs.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = fmt(vals[i], prec); });
    set(live.posRow.inputs, local.pos, 3);
    if (live.rotRow) set(live.rotRow.inputs, local.rotE, 2);
    const w = editor.pose().world.get(live.nodeId);
    if (w && live.worldEl) live.worldEl.textContent = worldText(w);
    if (live.partRows) {
      const ap = editor.displayPart(live.nodeId, live.partRows.id);
      if (ap) { set(live.partRows.pos.inputs, ap.pos, 3); set(live.partRows.rot.inputs, eulerOf(ap.rot), 2); set(live.partRows.scale.inputs, ap.scale, 3); }
    }
    if (live.dispRows) {
      const d = displayOf(editor.activeNode());
      set(live.dispRows.pos.inputs, d.pos, 3);
      set(live.dispRows.rot.inputs, eulerOf(d.rot), 2);
      set(live.dispRows.scale.inputs, d.scale, 3);
      if (document.activeElement !== live.dispRows.uni) live.dispRows.uni.value = fmt(Math.cbrt(Math.abs(d.scale[0] * d.scale[1] * d.scale[2])), 3);
    }
  }
  const keyedClass = (id, ch) => editor.channelKeyed(id, ch) ? (editor.hasKeyAt(id, ch) ? 'keyed-frame' : 'keyed') : '';

  // Transform diagnostics: every rotation/position representation of the node,
  // from rig rest to the waypoint the exporter would write (collapsed by default).
  function diagnosticsBlock(id) {
    const d = editor.transformDiagnostics(id);
    const det = h('details', { class: 'diag' }, h('summary', { text: t('props.diagnostics') }));
    if (!d) return det;
    const f3 = (v, p = 3) => v.map((x) => fmt(x, p)).join(', ');
    const line = (label, v, warn = false) => v ? h('div', { class: 'diag-row' + (warn ? ' warn' : '') }, h('span', { class: 'k', text: label }), h('span', { class: 'v', text: `${f3(v.pos)} m · ${f3(v.rot.map(normDeg), 2)}°` })) : null;
    det.append(
      line(t('diag.rest'), d.restLocal),
      line(t('diag.restWorld'), d.restWorld, d.restDiffersFromPlacement),
      h('div', { class: 'diag-row' }, h('span', { class: 'k', text: t('diag.correction') }), h('span', { class: 'v', text: f3(d.correction, 2) + '°' })),
      line(t('diag.anim'), d.local),
      line(t('diag.world'), d.world),
      line(t('diag.placement'), d.placement),
      d.placementGame ? h('div', { class: 'diag-row' }, h('span', { class: 'k', text: t('diag.placementGame') }), h('span', { class: 'v', text: `${f3(d.placementGame.pos)} m · ${f3(d.placementGame.rot, 2)}°` })) : null,
      d.waypointGame ? h('div', { class: 'diag-row' }, h('span', { class: 'k', text: t('diag.waypoint') }), h('span', { class: 'v', text: `${f3(d.waypointGame.pos)} m · ${f3(d.waypointGame.rot, 2)}°` })) : null,
      d.restDiffersFromPlacement ? hint(t('diag.restDiffers'), 'warn') : null,
      hint(t('diag.hint')),
    );
    return det;
  }

  // ---------- Properties ----------
  function renderProperties(body) {
    const p = editor.project;
    const node = editor.activeNode();
    const sel = editor.selectedNodes();
    if (!node) {
      body.append(empty(t('props.empty')));
      body.append(subhead(t('props.scene')));
      body.append(vec3Row(t('props.globalOffset'), p.settings.globalOffset || [0, 0, 0], (v) => editor.setGlobalOffset(v), { tip: t('tip.props.globalOffset') }));
      body.append(row(t('props.fps'), selectInput([24, 30, 60].map((f) => ({ value: f, label: String(f) })), p.settings.fps || 30, (v) => editor.setSetting('fps', parseInt(v, 10))), t('tip.props.fps')));
      return;
    }
    if (sel.length > 1) body.append(hint(t('props.multi', { n: sel.length })));
    body.append(row(t('props.name'), textInput(node.name, (v) => editor.renameNode(node.id, v.trim())), t('tip.props.name')));
    const parent = node.parent ? getNode(p, node.parent) : null;
    body.append(h('div', { class: 'stat-grid' },
      h('span', { class: 'k', text: t('props.type') }), h('span', { class: 'v', text: t('type.' + node.type) }),
      h('span', { class: 'k', text: t('props.parent') }), h('span', { class: 'v', text: parent ? parent.name : t('props.none') }),
    ));
    // transform
    const local = editor.currentLocal(node.id);
    const clip = activeClip(p);
    body.append(subhead(t('props.transform'), clip ? h('span', { class: 'chip', text: clip.name, title: t('props.transformClipHint') }) : null));
    const kc = (ch) => ['x', 'y', 'z'].map(() => keyedClass(node.id, ch));
    const posOnly = isPositionOnly(node);
    const posRow = vec3Row(t('props.position'), local.pos, (v) => editor.setNodeLocal(node.id, { pos: v }), { classes: kc('pos'), tip: t('tip.props.position') });
    // rotation fields show and accept the AUTHORED angles: 450° or -720° are kept as typed (multi-turn animation)
    const rotRow = posOnly ? null : vec3Row(t('props.rotation'), local.rotE, (v) => editor.setNodeLocal(node.id, { rot: quat.fromEulerDeg(v), rotE: v }), { step: 1, precision: 2, classes: kc('rot'), tip: t('tip.props.rotation') });
    body.append(posRow);
    if (rotRow) body.append(rotRow); else {
      body.append(hint(t('props.positionOnly')));
      body.append(checkbox(t('props.worldLocked'), !!node.worldLocked, (v) => editor.setWorldLocked(node.id, v), t('tip.props.worldLocked')));
    }
    const w = editor.pose().world.get(node.id);
    const worldEl = hint(worldText(w));
    if (w) body.append(worldEl);
    live = { nodeId: node.id, posRow, rotRow, worldEl };
    body.append(btnRow(
      button(t('props.keyPos'), () => editor.insertKeyframe([node.id], ['pos']), { disabled: !clip, tip: t('tip.props.keyPos') }),
      posOnly ? null : button(t('props.keyRot'), () => editor.insertKeyframe([node.id], ['rot']), { disabled: !clip, tip: t('tip.props.keyRot') }),
      button(t('props.reset'), () => editor.resetTransform(node.id), { tip: t('tip.props.reset') }),
      node.type === 'bone' ? button(t('props.freeze') + ' ▾', (e) => showMenu(e.currentTarget, [
        { label: t('props.freezeRot'), action: () => editor.freezeTransform(node.id, { pos: false, rot: true }) },
        { label: t('props.freezePos'), action: () => editor.freezeTransform(node.id, { pos: true, rot: false }) },
        { label: t('props.freezeBoth'), action: () => editor.freezeTransform(node.id, { pos: true, rot: true }) },
        ...(node.basis ? [{ sep: true }, { label: t('props.unfreeze'), action: () => editor.unfreezeTransform(node.id) }] : []),
      ]), { tip: t('tip.props.freeze') }) : null,
    ));
    if (node.type === 'bone' && node.basis) body.append(hint(t('props.frozenInfo', { rot: eulerOf(node.basis.rot).map((v) => fmt(v, 1)).join(', '), pos: node.basis.pos.map((v) => fmt(v, 3)).join(', ') })));
    if (editor.rotateMode === 'preserve') { body.append(hint(t('props.rotModeHint'), 'warn')); if (editor.moveRebaseInexact(node.id)) body.append(hint(t('props.rotModeMoveWarn'), 'warn')); }
    else if (clip) body.append(hint(t(p.settings.autoKey ? 'props.autoKeyOn' : 'props.autoKeyOff')));
    // unkeyed pose edit at this frame (Auto Key off): make the state visible and keyable
    if (editor.hasPoseOverride(node.id)) {
      body.append(hint(t('props.unkeyedPose'), 'warn'));
      body.append(btnRow(button(t('props.insertKey'), () => editor.insertKeyframe([node.id], [...(editor.hasPoseOverride(node.id, 'pos') ? ['pos'] : []), ...(editor.hasPoseOverride(node.id, 'rot') ? ['rot'] : [])]), { cls: 'mini primary-mini', tip: t('tip.props.keyRot') })));
    }
    // constraint-driven bone: say so instead of looking broken, offer the real controls
    const driver = node.type === 'bone' ? editor.constraintDriving(node.id) : null;
    if (driver) {
      body.append(hint(t('props.ikDriven', { name: driver.name }), 'warn'));
      body.append(btnRow(
        button(t('props.selectTarget'), () => { if (driver.targetId) editor.select(driver.targetId); }, { disabled: !driver.targetId }),
        button(t('props.switchFK'), () => editor.updateConstraint(driver.id, { enabled: false })),
      ));
    }
    if (node.type === 'object' || node.type === 'bone') body.append(diagnosticsBlock(node.id));
    if (node.type === 'object') {
      // Display model: editor-only offset of the display geometry (never exported)
      const on = editor.displayEdit;
      body.append(subhead(t('display.model'), h('span', { class: 'chip', text: t(on ? 'display.editing' : 'display.off'), style: on ? 'background:#22d3ee;color:#0b1116' : '' })));
      const sec = h('div', { class: 'display-section' + (on ? ' on' : '') });
      sec.append(btnRow(button(t(on ? 'display.stopEdit' : 'display.edit'), () => editor.toggleDisplayEdit(), { cls: on ? 'mini primary-mini' : 'mini', tip: t('tip.display.edit', { k: primaryKeyLabel('tool.displayEdit') }) })));
      // ---- display parts list ----
      const parts = editor.displayParts(node.id);
      const selIds = editor.displaySel;
      sec.append(h('div', { class: 'parts-head' }, h('span', { class: 'subhead-inline', text: t('display.parts') }), h('span', { class: 'meta', text: selIds.size ? t('display.selectedParts', { n: selIds.size, total: parts.length }) : String(parts.length) })));
      const list = h('div', { class: 'parts-list' });
      const ICON = { model: '▣', cuboid: '◇', cylinder: '○', sphere: '●' };
      // very large part lists are capped so selecting an object stays instant
      const CAP = 120;
      const shownParts = parts.length > CAP ? parts.filter((p, i) => i < CAP || selIds.has(p.id)) : parts;
      shownParts.forEach((p) => {
        const i = parts.indexOf(p);
        const rowEl = h('div', { class: 'list-row part' + (selIds.has(p.id) ? ' selected' : '') + (editor.displayActive === p.id ? ' active' : '') + (p.hidden ? ' hidden-part' : ''), dataset: { id: p.id }, title: p.source === 'file' ? t('display.filePart', { name: p.name }) : t('display.customPart', { kind: t('shape.' + (p.kind === 'model' ? 'model' : p.kind)) }) },
          h('span', { class: 'ico', text: ICON[p.kind] || '▣' }),
          h('span', { class: 'name', text: p.name }),
          p.edited || p.renamed ? h('span', { class: 'meta', text: '●', title: t('display.partEdited') }) : null,
          p.source === 'custom' ? h('span', { class: 'chip', text: t('display.customChip') }) : null,
          h('span', { class: 'vis' + (p.hidden ? ' off' : ''), text: p.hidden ? '◌' : '◉', title: t('tip.visibility'), onclick: (e) => { e.stopPropagation(); editor.setPartHidden(node.id, p.id, !p.hidden); } }),
        );
        rowEl.addEventListener('click', (e) => {
          if (!editor.displayEdit) editor.setDisplayEdit(true);
          if (e.shiftKey && editor.displayActive) {
            const a = parts.findIndex((x) => x.id === editor.displayActive), b = i;
            const range = parts.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
            editor.selectDisplayParts(range, 'add');
          } else editor.selectDisplayParts([p.id], (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace');
        });
        rowEl.addEventListener('dblclick', async () => { const v = await textPrompt({ title: t('display.rename'), label: t('display.partName'), value: p.name }); if (v) editor.renameDisplayPart(node.id, p.id, v); });
        list.append(rowEl);
      });
      if (!parts.length) list.append(empty(t('display.noParts')));
      if (shownParts.length < parts.length) list.append(h('div', { class: 'hint', text: t('display.moreParts', { n: parts.length - shownParts.length }) }));
      sec.append(list);
      const hasSel = selIds.size > 0;
      const selParts = editor.selectedDisplayParts();
      sec.append(btnRow(
        button(t('display.addPart') + ' ▾', (e) => showMenu(e.currentTarget, PART_KINDS.map((k) => ({ label: t('shape.' + k), icon: ICON[k], action: () => editor.addDisplayPart(node.id, k) }))), { tip: t('tip.display.addPart') }),
        button(t('display.duplicate'), () => editor.duplicateDisplayParts(node.id), { disabled: !hasSel, tip: t('tip.display.duplicate') }),
        button(selParts.length && selParts.every((p) => p.source === 'custom') ? t('display.delete') : t('display.hidePart'), () => editor.deleteDisplayParts(node.id), { disabled: !hasSel, cls: 'mini danger', tip: t('tip.display.delete') }),
      ));
      sec.append(btnRow(
        button('↑', () => editor.moveDisplayPart(node.id, editor.displayActive, -1), { disabled: !editor.displayActive, tip: t('display.moveUp') }),
        button('↓', () => editor.moveDisplayPart(node.id, editor.displayActive, 1), { disabled: !editor.displayActive, tip: t('display.moveDown') }),
        button(t('display.rename'), async () => { const p = editor.displayPart(node.id, editor.displayActive); if (!p) return; const v = await textPrompt({ title: t('display.rename'), label: t('display.partName'), value: p.name }); if (v) editor.renameDisplayPart(node.id, p.id, v); }, { disabled: !editor.displayActive }),
        button(t('display.resetPart'), () => { for (const p of selParts) editor.resetDisplayPart(node.id, p.id); }, { disabled: !hasSel, tip: t('tip.display.resetPart') }),
      ));
      // ---- active part transform ----
      const ap = editor.displayPart(node.id, editor.displayActive);
      if (ap) {
        sec.append(h('div', { class: 'subhead-inline', text: t('display.partTransform', { name: ap.name }) }));
        const pPos = vec3Row(t('display.offset'), ap.pos, (v) => editor.setPartTransform(node.id, ap.id, { pos: v }), { tip: t('tip.display.partOffset') });
        const pRot = vec3Row(t('display.rotation'), eulerOf(ap.rot), (v) => editor.setPartTransform(node.id, ap.id, { rot: quat.fromEulerDeg(v) }), { step: 1, precision: 2, tip: t('tip.display.partRotation') });
        const pScale = vec3Row(t('display.scale'), ap.scale, (v) => editor.setPartTransform(node.id, ap.id, { scale: v }), { step: 0.05, precision: 3, min: 0.001, tip: t('tip.display.partScale') });
        sec.append(pPos, pRot, pScale);
        live.partRows = { id: ap.id, pos: pPos, rot: pRot, scale: pScale };
      } else live.partRows = null;
      sec.append(hint(t('display.partsHint')));
      // ---- root offset (whole display model) ----
      sec.append(h('div', { class: 'subhead-inline', text: t('display.root') }));
      const d = displayOf(node);
      const dPos = vec3Row(t('display.offset'), d.pos, (v) => editor.setDisplayTransform(node.id, { pos: v }), { tip: t('tip.display.offset') });
      const dRot = vec3Row(t('display.rotation'), eulerOf(d.rot), (v) => editor.setDisplayTransform(node.id, { rot: quat.fromEulerDeg(v) }), { step: 1, precision: 2, tip: t('tip.display.rotation') });
      const dScale = vec3Row(t('display.scale'), d.scale, (v) => editor.setDisplayTransform(node.id, { scale: v }), { step: 0.05, precision: 3, min: 0.001, tip: t('tip.display.scale') });
      const uni = numInput(Math.cbrt(Math.abs(d.scale[0] * d.scale[1] * d.scale[2])), (v) => { const s = Math.max(0.001, v); editor.setDisplayTransform(node.id, { scale: [s, s, s] }); }, { step: 0.05, precision: 3, min: 0.001, width: 70 });
      sec.append(dPos, dRot, dScale, row(t('display.uniform'), uni, t('tip.display.uniform')));
      sec.append(btnRow(button(t('display.reset'), () => editor.resetDisplay(node.id), { disabled: !hasDisplayOffset(node) && !hasPartEdits(node), tip: t('tip.display.reset') })));
      sec.append(hint(t(on ? 'display.editHint' : 'display.modelHint')));
      body.append(sec);
      live.dispRows = { pos: dPos, rot: dRot, scale: dScale, uni };
      body.append(subhead(t('props.correction')));
      body.append(vec3Row(t('props.correctionRot'), node.correction || [0, 0, 0], (v) => editor.setCorrection(node.id, v), { step: 1, precision: 2, tip: t('tip.props.correction') }));
      body.append(btnRow(button(t('props.resetCorrection'), () => editor.resetCorrection(node.id), { disabled: !(node.correction || []).some((c) => c) })));
      body.append(hint(t('props.correctionHint')));
      body.append(subhead(t('props.objectInfo')));
      const unknown = (node.decorations || []).filter((d) => !modelInfo(d.modelId)).length;
      body.append(h('div', { class: 'stat-grid' },
        h('span', { class: 'k', text: 'GUID' }), h('span', { class: 'v', text: String(node.guid ?? '—') }),
        h('span', { class: 'k', text: t('props.zoom') }), h('span', { class: 'v', text: (node.zoom || [1, 1, 1]).map((z) => fmt(z, 3)).join(' × ') }),
        h('span', { class: 'k', text: t('project.decorations') }), h('span', { class: 'v', text: String(node.decorations?.length || 0) + (unknown ? ` (${t('props.unknownN', { n: unknown })})` : '') }),
        h('span', { class: 'k', text: t('props.unitType') }), h('span', { class: 'v', text: node.isStatic ? t('props.static') : t('props.dynamic') }),
      ));
      if (node.isStatic) body.append(hint(t('props.staticHint'), 'warn'));
      if (unknown) body.append(hint(t('props.unknownHint')));
    } else if (node.type === 'bone') {
      body.append(subhead(t('props.bone')));
      body.append(row(t('props.length'), numInput(node.length, (v) => editor.setNodeProps(node.id, { length: Math.max(0.01, v) }), { step: 0.05, min: 0.01 }), t('tip.props.length')));
    } else if (node.type === 'proxy') {
      body.append(subhead(t('props.proxy')));
      body.append(row(t('props.shape'), selectInput(['cuboid', 'cylinder', 'sphere'].map((s) => ({ value: s, label: t('shape.' + s) })), node.shape, (v) => editor.setNodeProps(node.id, { shape: v }))));
      body.append(vec3Row(t('props.size'), node.size, (v) => editor.setNodeProps(node.id, { size: v.map((x) => Math.max(0.001, x)) }), { step: 0.05, tip: t('tip.props.size') }));
      const color = h('input', { type: 'color', value: node.color || '#7ec8ff' });
      color.addEventListener('change', () => editor.setNodeProps(node.id, { color: color.value }));
      body.append(row(t('props.color'), color));
      body.append(hint(t('props.proxyHint')));
    } else if (node.type === 'target' || node.type === 'pole') {
      const used = p.constraints.filter((k) => k.targetId === node.id || k.poleId === node.id);
      body.append(hint(used.length ? t('props.usedBy', { names: used.map((k) => k.name).join(', ') }) : t('props.unused')));
    }
    if (sel.length > 1) body.append(btnRow(button(t('btn.deleteSelected'), () => editor.deleteSelected(), { cls: 'mini danger' })));
  }

  // ---------- Rigging ----------
  function renderRigging(body) {
    const p = editor.project;
    const node = editor.activeNode();
    const bones = p.nodes.filter((n) => n.type === 'bone');
    const boneOptions = [{ value: '', label: t('props.none') }, ...bones.map((b) => ({ value: b.id, label: b.name }))];
    if (!node) {
      body.append(empty(t('rig.empty')));
      body.append(btnRow(button(t('add.bone'), () => editor.addBone(null), { tip: t('tip.add.bone') })));
    } else if (node.type === 'bone') {
      body.append(subhead(t('rig.bone', { name: node.name })));
      body.append(row(t('props.length'), numInput(node.length, (v) => editor.setNodeProps(node.id, { length: Math.max(0.01, v) }), { step: 0.05, min: 0.01 })));
      body.append(row(t('rig.parentBone'), selectInput(boneOptions.filter((o) => o.value !== node.id), node.parent && getNode(p, node.parent)?.type === 'bone' ? node.parent : '', (v) => editor.reparentNodes([node.id], v || null))));
      body.append(btnRow(
        button(t('rig.addChildBone'), () => editor.addBone(node.id), { tip: t('tip.rig.addChildBone') }),
        button(t('rig.addIK'), () => editor.addConstraint(node.id), { tip: t('tip.rig.addIK') }),
      ));
      const others = editor.selectedNodes().filter((n) => n.id !== node.id && n.type !== 'bone');
      if (others.length) body.append(btnRow(button(t('rig.attachSelected', { n: others.length }), () => editor.reparentNodes(others.map((n) => n.id), node.id), { tip: t('tip.rig.attach') })));
      else body.append(hint(t('rig.attachHint')));
    } else {
      body.append(subhead(t('rig.object', { name: node.name })));
      body.append(row(t('rig.attachTo'), selectInput(boneOptions, node.parent && getNode(p, node.parent)?.type === 'bone' ? node.parent : '', (v) => editor.reparentNodes([node.id], v || null)), t('tip.rig.attachTo')));
      if (!bones.length) body.append(hint(t('rig.noBones')));
      body.append(btnRow(
        button(t('rig.addBoneHere'), () => editor.addBone(null), { tip: t('tip.rig.addBoneHere') }),
        button(t('add.bonesForSelected'), () => editor.addBonesForSelected(), { tip: t('tip.add.bonesForSelected') }),
      ));
    }
    body.append(subhead(t('autorig.title')));
    body.append(btnRow(button(t('autorig.button'), () => showAutoRigDialog(editor), { cls: 'mini', tip: t('tip.autorig') })));
    body.append(subhead(t('orient.section')));
    body.append(hint(t('orient.intro')));
    body.append(btnRow(
      button(t('orient.button'), () => showReorientDialog(editor), { cls: 'mini', tip: t('tip.orient.button') }),
      button(t('scale.button'), () => showScaleModelDialog(editor), { cls: 'mini', tip: t('tip.scale.button') }),
    ));
    body.append(hint(t('autorig.intro')));
    body.append(subhead(t('rig.constraints'), h('span', { class: 'count', style: 'margin-left:auto', text: String(p.constraints.length) })));
    if (!p.constraints.length) body.append(hint(t('rig.noConstraints')));
    for (const k of p.constraints) {
      const el = h('div', { class: 'slot' });
      const issues = constraintIssues(p, k);
      el.append(h('div', { class: 'slot-head' }, h('span', { class: 'ico target', text: '⊕' }), textInput(k.name, (v) => editor.updateConstraint(k.id, { name: v })), button('✕', () => editor.removeConstraint(k.id), { cls: 'mini danger', tip: t('tip.rig.removeIK') })));
      el.append(row(t('rig.tipBone'), selectInput(boneOptions, k.boneId, (v) => editor.updateConstraint(k.id, { boneId: v })), t('tip.rig.tipBone')));
      const targets = p.nodes.filter((n) => n.type !== 'object' || true).map((n) => ({ value: n.id, label: `${n.name} (${t('type.' + n.type)})` }));
      const targetRow = row(t('rig.target'), selectInput([{ value: '', label: t('props.none') }, ...targets], k.targetId || '', (v) => editor.updateConstraint(k.id, { targetId: v || null })), t('tip.rig.target'));
      targetRow.append(button('⌖', () => editor.select(k.targetId), { disabled: !k.targetId, cls: 'mini', tip: t('tip.rig.selectTarget') }));
      el.append(targetRow);
      const poleRow = row(t('rig.pole'), selectInput([{ value: '', label: t('props.none') }, ...targets], k.poleId || '', (v) => editor.updateConstraint(k.id, { poleId: v || null })), t('tip.rig.pole'));
      poleRow.append(button('⌖', () => editor.select(k.poleId), { disabled: !k.poleId, cls: 'mini', tip: t('tip.rig.selectPole') }));
      el.append(poleRow);
      if (!k.poleId) el.append(btnRow(button(t('rig.createPole'), () => editor.addPoleFor(k.id), { tip: t('tip.rig.createPole') })));
      el.append(row(t('rig.chainLength'), numInput(k.chainLength, (v) => editor.updateConstraint(k.id, { chainLength: Math.max(1, Math.round(v)) }), { step: 1, min: 1, precision: 0, width: 60 }), t('tip.rig.chainLength')));
      const chain = chainBones(p, k);
      el.append(hint(t('rig.chainInfo', { bones: chain.map((b) => b.name).join(' → ') || '—' })));
      el.append(checkbox(k.enabled ? t('rig.ikOn') : t('rig.ikOff'), k.enabled, (v) => editor.updateConstraint(k.id, { enabled: v }), t('tip.rig.ikfk')));
      el.append(row(t('rig.influence'), slider(k.influence ?? 1, (v, commit) => { k.influence = v; if (commit) editor.updateConstraint(k.id, { influence: v }); else editor.transient(); }), t('tip.rig.influence')));
      el.append(row(t('rig.iterations'), numInput(k.iterations || 12, (v) => editor.updateConstraint(k.id, { iterations: Math.max(1, Math.round(v)) }), { step: 1, min: 1, precision: 0, width: 60 })));
      for (const i of issues) el.append(hint(t('val.ik.' + i, { name: k.name }), i === 'missingPole' ? 'warn' : 'err'));
      body.append(el);
    }
    body.append(hint(t('rig.help')));
  }

  // ---------- Display ----------
  function renderDisplay(body) {
    const S = editor.project.settings;
    body.append(row(t('display.opacity'), slider(S.proxyOpacity, (v, commit) => editor.setSetting('proxyOpacity', v, commit), { min: 0.05, max: 1, step: 0.01 }), t('tip.display.opacity')));
    body.append(hint(t('display.opacityHint')));
    const toggles = [['showDecorations', 'display.decorations'], ['showProxies', 'display.proxies'], ['showBones', 'display.bones'], ['showAxes', 'display.axes'], ['showPivots', 'display.pivots'], ['showConstraints', 'display.constraints'], ['showWaypaths', 'display.waypaths'], ['showGrid', 'display.grid']];
    for (const [key, label] of toggles) body.append(checkbox(t(label), S[key] !== false, (v) => editor.setSetting(key, v)));
    body.append(subhead(t('display.viewport')));
    const stats = editor.sceneStats();
    body.append(row(t('display.unknown'), selectInput([{ value: 'simplified', label: t('display.unknownSimplified') }, { value: 'boxes', label: t('display.unknownBoxes') }, { value: 'hidden', label: t('display.unknownHidden') }], editor.view.unknownMode || 'simplified', (v) => editor.setViewPref({ unknownMode: v })), t('tip.display.unknown')));
    body.append(hint(t('display.unknownHint')));
    const perfRow = row(t('display.perf'), selectInput([{ value: 'auto', label: t('display.perfAuto') }, { value: 'on', label: t('display.perfOn') }, { value: 'off', label: t('display.perfOff') }], editor.view.perfMode || 'auto', (v) => editor.setViewPref({ perfMode: v })), t('tip.display.perf'));
    perfRow.append(h('span', { class: 'chip' + (stats.perf ? ' warn' : ''), text: stats.perf ? t('display.perfActive') : t('display.perfInactive') }));
    body.append(perfRow);
    body.append(hint(t('display.perfHint', { parts: stats.parts })));
    // native range input; the value is applied live and the panel is NOT re-rendered
    // while dragging (a rebuilt input would end the drag under the pointer)
    brightnessInput = slider(editor.view.brightness ?? 1, (v) => editor.setViewPref({ brightness: v }), { min: 0.3, max: 2.2, step: 0.05 });
    brightnessInput.dataset.focusId = 'brightness';
    const bRow = row(t('display.brightness'), brightnessInput, t('tip.display.brightness'));
    bRow.append(button('\u21ba', () => editor.setViewPref({ brightness: 1 }), { tip: t('display.resetBrightness'), cls: 'mini' }));
    body.append(bRow);
    body.append(subhead(t('display.navigation')));
    const group = (label, ...items) => h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-title', text: label }), ...items);
    body.append(group(t('display.pan'),
      checkbox(t('display.reversePanX'), !!editor.view.reversePanX, (v) => editor.setViewPref({ reversePanX: v }), t('tip.display.reversePan')),
      checkbox(t('display.reversePanY'), !!editor.view.reversePanY, (v) => editor.setViewPref({ reversePanY: v }), t('tip.display.reversePan'))));
    body.append(group(t('display.orbit'),
      checkbox(t('display.reverseOrbitX'), !!editor.view.reverseOrbitX, (v) => editor.setViewPref({ reverseOrbitX: v }), t('tip.display.reverseOrbit')),
      checkbox(t('display.reverseOrbitY'), !!editor.view.reverseOrbitY, (v) => editor.setViewPref({ reverseOrbitY: v }), t('tip.display.reverseOrbit'))));
    body.append(group(t('display.keyboard'),
      checkbox(t('display.wasd'), editor.wasd, (v) => editor.setWasd(v), t('tip.display.wasd'))));
    body.append(hint(t('display.navHint')));
    body.append(subhead(t('display.proxies')));
    body.append(btnRow(
      button(t('shape.cuboid'), () => editor.addProxy('cuboid')),
      button(t('shape.cylinder'), () => editor.addProxy('cylinder')),
      button(t('shape.sphere'), () => editor.addProxy('sphere')),
    ));
    body.append(hint(t('display.proxyHint')));
  }

  // ---------- Waypaths ----------
  function renderWaypaths(body) {
    const p = editor.project;
    const active = editor.activeWaypath();
    body.append(hint(t('path.intro')));
    body.append(btnRow(
      button(t('path.addDirectional'), () => editor.addWaypath('direction'), { tip: t('tip.path.directional') }),
      button(t('path.addManual'), () => editor.addWaypath('manual'), { tip: t('tip.path.manual') }),
    ));
    if (!p.waypaths.length) { body.append(empty(t('path.empty'))); return; }
    const list = h('div', { class: 'list' });
    for (const wp of p.waypaths) {
      const r = h('div', { class: 'list-row' + (wp.id === p.activeWaypathId ? ' active' : '') },
        h('span', { class: 'ico proxy', text: '↝' }), h('span', { class: 'name', text: wp.name }),
        h('span', { class: 'chip', text: t(wp.kind === 'direction' ? 'path.directional' : 'path.manual') }),
        wp.enabled ? h('span', { class: 'chip loop', text: t('path.preview') }) : null);
      r.addEventListener('click', () => editor.setActiveWaypath(wp.id));
      list.append(r);
    }
    body.append(list);
    if (!active) return;
    const wp = active;
    body.append(subhead(wp.name, button('✕', () => editor.removeWaypath(wp.id), { cls: 'mini danger', tip: t('tip.path.remove') })));
    body.append(row(t('props.name'), textInput(wp.name, (v) => editor.updateWaypath(wp.id, { name: v }))));
    body.append(checkbox(t('path.enabled'), wp.enabled, (v) => editor.updateWaypath(wp.id, { enabled: v }), t('tip.path.enabled')));
    body.append(checkbox(t('path.loop'), wp.loop, (v) => editor.updateWaypath(wp.id, { loop: v })));
    body.append(checkbox(t('path.face'), wp.faceDirection, (v) => editor.updateWaypath(wp.id, { faceDirection: v }), t('tip.path.face')));
    if (wp.kind === 'direction') {
      body.append(vec3Row(t('path.direction'), wp.direction, (v) => editor.updateWaypath(wp.id, { direction: v }), { step: 0.1, tip: t('tip.path.direction') }));
      body.append(h('div', { class: 'row' }, checkbox(t('path.velocity'), wp.useVelocity, (v) => editor.updateWaypath(wp.id, { useVelocity: v || !wp.useDuration })), numInput(wp.velocity, (v) => editor.updateWaypath(wp.id, { velocity: Math.max(0, v) }), { step: 0.1, min: 0 })));
      body.append(h('div', { class: 'row' }, checkbox(t('path.duration'), wp.useDuration, (v) => editor.updateWaypath(wp.id, { useDuration: v || !wp.useVelocity })), numInput(wp.duration, (v) => editor.updateWaypath(wp.id, { duration: Math.max(0, v) }), { step: 0.1, min: 0 })));
      if (!wp.useVelocity) body.append(row(t('path.distance'), numInput(wp.distance || 2, (v) => editor.updateWaypath(wp.id, { distance: Math.max(0, v) }), { step: 0.1, min: 0 })));
      const e = effectiveDirectional(wp);
      body.append(hint(t('path.summary', { d: fmt(e.distance, 2), v: fmt(e.velocity, 2), s: fmt(e.duration, 2) })));
    } else {
      body.append(subhead(t('path.points')));
      wp.points.forEach((pt, i) => {
        const selP = editor.pathPointSel && editor.pathPointSel.wpId === wp.id && editor.pathPointSel.index === i;
        const r = vec3Row(`${i + 1}`, pt, (v) => editor.setPathPoint(wp.id, i, v), { step: 0.1 });
        r.append(btnRow(button(selP ? '●' : '○', () => editor.selectPathPoint(wp.id, selP ? null : i), { tip: t('tip.path.selectPoint') }), button('✕', () => editor.removePathPoint(wp.id, i), { cls: 'mini danger', disabled: wp.points.length <= 2, tip: t('tip.path.removePoint') })));
        r.style.gridTemplateColumns = '24px 1fr 1fr 1fr 60px';
        body.append(r);
      });
      body.append(btnRow(
        button(t('path.addPoint'), () => editor.addPathPoint(wp.id, editor.pathPointSel?.wpId === wp.id ? editor.pathPointSel.index : null), { tip: t('tip.path.addPoint') }),
        button(t('path.simplify'), () => showSimplifyPathDialog(editor, wp.id), { disabled: wp.points.length <= 2, tip: t('tip.path.simplify') }),
      ));
      body.append(hint(t('path.pointHint')));
      body.append(h('div', { class: 'row' }, checkbox(t('path.duration'), wp.useDuration, (v) => editor.updateWaypath(wp.id, { useDuration: v })), numInput(wp.duration, (v) => editor.updateWaypath(wp.id, { duration: Math.max(0, v) }), { step: 0.1, min: 0 })));
      if (!wp.useDuration) body.append(row(t('path.velocity'), numInput(wp.velocity, (v) => editor.updateWaypath(wp.id, { velocity: Math.max(0.01, v) }), { step: 0.1, min: 0.01 })));
      body.append(hint(t('path.summaryManual', { d: fmt(pathLength(wp), 2), s: fmt(pathDuration(wp), 2) })));
    }
    body.append(btnRow(button(t('path.bake'), async () => { if (await confirmDialog({ title: t('path.bake'), message: t('path.bakeConfirm') })) editor.bakeWaypath(wp.id); }, { disabled: !activeClip(p), tip: t('tip.path.bake') })));
    body.append(hint(t('path.bakeHint')));
  }

  function renderAll(which = ['properties', 'rigging', 'display', 'waypaths']) {
    if (which.includes('properties')) rerender(bodies.properties, renderProperties);
    if (which.includes('rigging')) rerender(bodies.rigging, renderRigging);
    if (which.includes('display')) rerender(bodies.display, renderDisplay);
    if (which.includes('waypaths')) { rerender(bodies.waypaths, renderWaypaths); wpCount.textContent = editor.project.waypaths.length ? String(editor.project.waypaths.length) : ''; }
  }
  let liveAt = 0;
  editor.on('change', (d) => {
    if (d?.transient) {
      // Performance Mode: inspector values refresh at ~10 Hz during playback
      if (editor.playing && editor.perfActive()) { const now = performance.now(); if (now - liveAt < 100) return; liveAt = now; }
      updateLive(); return;
    }
    renderAll();
  });
  editor.on('selection', () => renderAll(['properties', 'rigging', 'waypaths']));
  editor.on('time', () => renderAll(['properties']));
  editor.on('overrides', () => renderAll(['properties']));
  editor.on('displaySel', () => renderAll(['properties']));
  editor.on('view', () => { if (brightnessInput && brightnessInput.isConnected && document.activeElement !== brightnessInput) brightnessInput.value = String(editor.view.brightness ?? 1); });
  editor.on('tool', () => renderAll(['display', 'properties']));
  onLangChange(() => renderAll());
  renderAll();
  return { renderAll };
}
