// Reorient Model: presets (which way the model faces now → +Z), quick Y turns,
// custom X/Y/Z degrees, live preview, then one undoable whole-model rotation
// frozen into the rest basis.
import { t } from '../i18n/i18n.js';
import { h, button, btnRow, hint, selectInput, checkbox, vec3Row, fmt } from './dom.js';
import { customDialog, toast } from './dialogs.js';
import { quat } from '../core/math.js';
import { FORWARDS, EDITOR_FORWARD, headingOf, headingName, yawBetween, yawQuat, modelForward } from '../anim/orient.js';

export async function showReorientDialog(editor, { suggestedYaw = null } = {}) {
  const detected = modelForward(editor.project);
  let current = detected ? detected.name : EDITOR_FORWARD;
  let target = EDITOR_FORWARD;
  let custom = [0, suggestedYaw ?? 0, 0];
  let mode = suggestedYaw != null ? 'custom' : 'preset';
  let preview = true;
  const body = h('div', { class: 'limit orient' });
  const result = h('div', { class: 'hint' });
  const rotation = () => {
    if (mode === 'preset') return yawQuat(yawBetween(headingOf(FORWARDS[current]), headingOf(FORWARDS[target])));
    return quat.fromEulerDeg(custom);
  };
  const describe = () => {
    const q = rotation();
    const e = mode === 'preset' ? [0, yawBetween(headingOf(FORWARDS[current]), headingOf(FORWARDS[target])), 0] : custom;
    const facing = headingName(headingOf(quat.rotate(q, FORWARDS[current])));
    result.textContent = t('orient.result', { x: fmt(e[0], 1), y: fmt(e[1], 1), z: fmt(e[2], 1), fwd: facing });
    editor.setOrientPreview(preview ? q : null);
  };
  const opts = Object.keys(FORWARDS).map((k) => ({ value: k, label: t('orient.dir.' + k.replace('+', 'p').replace('-', 'm')) }));
  const curSel = selectInput(opts, current, (v) => { current = v; mode = 'preset'; describe(); });
  const tgtSel = selectInput(opts, target, (v) => { target = v; mode = 'preset'; describe(); });
  const customRow = vec3Row(t('orient.custom'), custom, (v) => { custom = v; mode = 'custom'; describe(); }, { step: 15, precision: 1, tip: t('tip.orient.custom') });
  const quick = (deg) => button(t('orient.turn', { deg }), () => { custom = [0, deg, 0]; mode = 'custom'; customRow.inputs.forEach((inp, i) => { inp.value = String(custom[i]); }); describe(); }, { cls: 'mini' });
  body.append(
    hint(t('orient.explain')),
    detected ? hint(t('orient.detected', { fwd: detected.name })) : hint(t('orient.notDetected')),
    h('div', { class: 'row' }, h('span', { class: 'label', text: t('orient.current') }), curSel),
    h('div', { class: 'row' }, h('span', { class: 'label', text: t('orient.target') }), tgtSel),
    h('div', { class: 'subhead-inline', text: t('orient.quick') }),
    btnRow(quick(90), quick(-90), quick(180)),
    customRow,
    checkbox(t('orient.preview'), preview, (v) => { preview = v; describe(); }),
    result,
    hint(t('orient.freezeNote')),
  );
  describe();
  const r = await customDialog({ title: t('orient.title'), body, buttons: [
    { label: t('btn.cancel'), value: () => 'cancel' },
    { label: t('orient.apply'), primary: true, value: () => 'apply' },
  ] });
  const q = rotation();
  editor.setOrientPreview(null);
  if (r !== 'apply') return;
  if (!editor.reorientModel(q)) { toast(t('orient.noop'), 'info'); return; }
  toast(t('orient.applied', { deg: fmt(quat.toEulerDeg(q)[1], 1), fwd: headingName(headingOf(quat.rotate(q, FORWARDS[current]))) }), 'success', 4000);
}
