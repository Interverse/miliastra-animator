// Compact project header: the small persistent context strip at the top of the left rail.
//
// It is identical in Model / Rig / Animate / Export and lives outside the scrolling panel
// area, so project-level context never moves or changes size when the workspace changes.
// It answers only "which project is open" and "is it saved"; everything larger belongs
// elsewhere — project actions in the File menu (and the ⋯ menu here), technical metadata in
// the collapsed Project details, and workflow controls in the workspace panels themselves.
import { t, onLangChange } from '../i18n/i18n.js';
import { h, button, hint } from './dom.js';
import { showMenu, textPrompt, confirmDialog } from './dialogs.js';
import { loadPrefs, updatePrefs } from '../core/persistence.js';
import { primaryKeyLabel } from './shortcuts.js';
import { workflowState } from './workflow.js';

const fmtDate = (ts) => { try { return new Date(ts).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return new Date(ts).toLocaleString(); } };

export function initProjectBar(editor) {
  const bar = document.getElementById('project-bar');
  const step = document.getElementById('next-step');

  const renameProject = async () => {
    const current = editor.projectName || editor.defaultProjectName();
    const v = await textPrompt({ title: t('start.rename'), label: t('project.namePrompt'), value: current });
    if (!v || v === current) return;
    if (editor.projectId) await editor.renameLocal(editor.projectId, v);
    else { editor.projectName = v; editor.emit('dirty'); editor.emit('projects'); }
  };

  function projectMenu(anchor, hasContent) {
    showMenu(anchor, [
      { label: t('project.saveLocal'), key: primaryKeyLabel('file.save'), icon: '💾', disabled: !hasContent, action: () => editor.saveLocal() },
      { label: t('project.saveAs') + '…', key: primaryKeyLabel('file.saveAs'), icon: '💾', disabled: !hasContent, action: () => editor.saveLocal({ as: true }) },
      { label: t('start.rename') + '…', icon: '✎', disabled: !hasContent, action: renameProject },
      { sep: true },
      { label: t('project.allProjects') + '…', icon: '📁', action: () => editor.showProjectsDialog?.() },
      { label: t('project.open') + '…', icon: '⤓', action: () => editor.importProjectGuarded?.() },
      { label: t('project.new'), icon: '✦', action: async () => { if (await (editor.guardUnsaved ? editor.guardUnsaved() : confirmDialog({ title: t('project.new'), message: t('project.newConfirm'), danger: true }))) editor.newProject(); } },
    ]);
  }

  function renderBar() {
    const p = editor.project;
    const objs = p.nodes.filter((n) => n.type === 'object');
    const hasContent = objs.length > 0 || p.clips.length > 0;
    const name = hasContent || editor.projectId ? (editor.projectName || editor.defaultProjectName()) : t('project.untitled');
    bar.innerHTML = '';
    const menuBtn = h('button', { class: 'pb-menu', text: '⋯', title: t('project.actions'), 'aria-label': t('project.actions') });
    menuBtn.addEventListener('click', (e) => projectMenu(e.currentTarget, hasContent));
    bar.append(h('div', { class: 'pb-main' }, h('span', { class: 'pb-name', text: name, title: name }), menuBtn));
    if (!hasContent) return; // nothing open yet: the name alone is the whole context
    const sub = h('div', { class: 'pb-sub' });
    if (editor.giaName) sub.append(h('span', { class: 'pb-file', text: editor.giaName, title: editor.giaName }), h('span', { class: 'pb-sep', text: '·' }));
    sub.append(h('span', { class: 'pb-state' + (editor.dirty ? ' dirty' : ''), text: t(editor.dirty ? 'project.stateUnsaved' : 'project.stateSaved') }));
    bar.append(sub);
    // Project details: metadata that is occasionally useful and never part of the workflow.
    const det = h('details', { class: 'pb-details', open: !!loadPrefs().projectDetails }, h('summary', { text: t('project.details') }));
    det.addEventListener('toggle', () => updatePrefs({ projectDetails: det.open }));
    const decs = objs.reduce((a, o) => a + (o.decorations?.length || 0), 0);
    det.append(h('div', { class: 'pb-grid' },
      h('span', { class: 'k', text: t('project.file') }), h('span', { class: 'v', text: editor.giaName || '—', title: editor.giaName || '' }),
      h('span', { class: 'k', text: t('project.modified') }), h('span', { class: 'v', text: editor.lastSavedAt ? fmtDate(editor.lastSavedAt) : '—' }),
      h('span', { class: 'k', text: t('project.objects') }), h('span', { class: 'v', text: String(objs.length) }),
      h('span', { class: 'k', text: t('project.decorations') }), h('span', { class: 'v', text: String(decs) }),
      h('span', { class: 'k', text: t('panel.clips') }), h('span', { class: 'v', text: String(p.clips.length) }),
    ));
    if (editor.importInfo?.controllerFound) det.append(hint(t('project.controllerNote')));
    det.append(hint(t('project.localHint')));
    bar.append(det);
  }

  // One line naming the next useful action, always re-derived from the current project.
  function renderStep() {
    const st = workflowState(editor);
    step.hidden = st.step === 'done';
    if (step.hidden) return;
    step.innerHTML = '';
    step.append(h('span', { class: 'ns-text', text: t('guide.next.' + st.step), title: st.step === 'rig' ? t('guide.optional') : null }));
    if (st.step === 'import') { step.append(button(t('viewport.import'), () => editor.pickGiaFile?.(), { cls: 'mini primary-mini' })); return; }
    const target = { rig: 'rig', animate: 'animate', keys: 'animate', export: 'export' }[st.step];
    if (target !== editor.mode) step.append(button(t('mode.' + target) + ' →', () => editor.setMode(target), { cls: 'mini' }));
    else if (st.step === 'animate') step.append(button(t('export.addAnimation'), () => editor.createClip(), { cls: 'mini primary-mini' }));
    else if (st.step === 'export') step.append(button(t('export.download'), () => document.getElementById('btn-export')?.focus(), { cls: 'mini' }));
  }

  const render = () => { renderBar(); renderStep(); };
  editor.on('change', (d) => { if (!d?.transient) render(); });
  editor.on('dirty', render);
  editor.on('projects', render);
  editor.on('mode', renderStep);
  editor.on('export', renderStep);
  onLangChange(render);
  render();
  return { render };
}
