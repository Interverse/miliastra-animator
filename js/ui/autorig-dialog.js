// Experimental Auto-Rig dialog: analyse → confirm type → preview bones in the
// viewport → adjust names / assignments / skip bones → apply as one undo step.
import { t } from '../i18n/i18n.js';
import { h, button, btnRow, hint, selectInput, checkbox } from './dom.js';
import { customDialog, toast } from './dialogs.js';
import { RIG_TYPES, BASE_POSES, DEFAULT_POSE } from '../rig/autorig.js';
import { getNode } from '../scene/scene.js';

export async function showAutoRigDialog(editor) {
  const objects = editor.project.nodes.filter((n) => n.type === 'object');
  if (!objects.length) { toast(t('autorig.noObjects'), 'warn'); return; }
  const selObjs = editor.selectedNodes().filter((n) => n.type === 'object');
  const scope = selObjs.length > 1 ? selObjs.map((n) => n.id) : null; // several selected objects → rig those; else the whole model
  let type = 'auto', ik = false, pose = null; // pose null = template default (T-pose for humanoids)
  let proposal = editor.proposeAutoRig({ objectIds: scope, type, ik, pose });
  const body = h('div', { class: 'autorig' });
  const summary = h('div');
  const list = h('div', { class: 'autorig-list' });
  const unassigned = h('div');
  const rebuild = () => {
    proposal = editor.proposeAutoRig({ objectIds: scope, type, ik, pose });
    editor.setRigPreview(proposal);
    render();
  };
  const poseRow = h('div', { class: 'row' });
  const renderPose = () => {
    poseRow.innerHTML = '';
    const poses = BASE_POSES[proposal.type] || ['detected'];
    const current = pose && poses.includes(pose) ? pose : (DEFAULT_POSE[proposal.type] || 'detected');
    poseRow.append(h('span', { class: 'label', text: t('autorig.basePose') }), selectInput(poses.map((k) => ({ value: k, label: t('autorig.pose.' + k) })), current, (v) => { pose = v; rebuild(); }));
  };
  const render = () => {
    summary.innerHTML = '';
    const conf = Math.round(proposal.confidence * 100);
    summary.append(
      h('div', { class: 'hint' }, t('autorig.explain')),
      h('div', { class: 'stat-grid' },
        h('span', { class: 'k', text: t('autorig.detected') }), h('span', { class: 'v', text: `${t('autorig.type.' + proposal.detected)} · ${t('autorig.confidence', { pct: conf })}` }),
        h('span', { class: 'k', text: t('autorig.scope') }), h('span', { class: 'v', text: scope ? t('autorig.scopeSelected', { n: scope.length }) : t('autorig.scopeAll', { n: proposal.feats.length }) }),
      ),
    );
    if (proposal.confidence < 0.5 && type === 'auto') summary.append(hint(t('autorig.lowConfidence'), 'warn'));
    renderPose();
    summary.append(hint(t(proposal.pose === 'detected' ? 'autorig.poseKeep' : 'autorig.poseInfo', { pose: t('autorig.pose.' + proposal.pose) })));
    if (proposal.existingBones) summary.append(hint(t('autorig.existingRig', { n: proposal.existingBones }), 'warn'));
    list.innerHTML = '';
    if (!proposal.bones.length) list.append(h('div', { class: 'empty', text: t('autorig.noBones') }));
    for (const b of proposal.bones) {
      const rowEl = h('div', { class: 'autorig-row' });
      const cb = h('input', { type: 'checkbox', checked: !b.skip, title: t('autorig.includeBone') });
      cb.addEventListener('change', () => { b.skip = !cb.checked; editor.setRigPreview(proposal); });
      const name = h('input', { type: 'text', value: b.name });
      name.addEventListener('change', () => { b.name = name.value.trim() || b.name; });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      const parent = h('span', { class: 'k', text: b.parentKey ? proposal.bones.find((x) => x.key === b.parentKey)?.name || '' : t('autorig.root') });
      const objs = h('span', { class: 'k', text: b.objects.map((id) => getNode(editor.project, id)?.name || '?').join(', ') || '—', title: b.objects.map((id) => getNode(editor.project, id)?.name).join('\n') });
      const conf = h('span', { class: 'conf' + (b.confidence < 0.5 ? ' low' : ''), text: `${Math.round(b.confidence * 100)}%` });
      rowEl.append(cb, name, parent, objs, conf);
      list.append(rowEl);
    }
    unassigned.innerHTML = '';
    if (proposal.unassigned.length) unassigned.append(hint(t('autorig.unassigned', { names: proposal.unassigned.map((id) => getNode(editor.project, id)?.name || id).join(', ') }), 'warn'));
    if (proposal.ik.length) unassigned.append(hint(t('autorig.ikInfo', { n: proposal.ik.length })));
  };
  const typeSel = selectInput(RIG_TYPES.map((k) => ({ value: k, label: t('autorig.type.' + k) })), type, (v) => { type = v; rebuild(); });
  const ikBox = checkbox(t('autorig.ik'), ik, (v) => { ik = v; rebuild(); }, t('tip.autorig.ik'));
  body.append(h('div', { class: 'hint warn' }, t('autorig.experimental')), summary, h('div', { class: 'row' }, h('span', { class: 'label', text: t('autorig.modelType') }), typeSel), poseRow, ikBox, h('div', { class: 'subhead-inline', text: t('autorig.proposed') }), list, unassigned, hint(t('autorig.notes')));
  editor.setRigPreview(proposal);
  render();
  const r = await customDialog({ title: t('autorig.title'), body, buttons: [
    { label: t('btn.cancel'), value: () => 'cancel' },
    { label: t('autorig.apply'), primary: true, value: () => 'apply' },
  ] });
  editor.setRigPreview(null);
  if (r !== 'apply') return;
  const kept = proposal.bones.filter((b) => !b.skip);
  if (!kept.length) { toast(t('autorig.noBones'), 'warn'); return; }
  const created = editor.applyAutoRig(proposal);
  toast(t('autorig.applied', { bones: created.bones.length, ik: created.constraints.length }), 'success', 4000);
}
