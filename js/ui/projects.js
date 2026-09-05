// Local projects UI: Recent Projects start screen, in-editor Projects menu and
// browser dialog, the saved / unsaved indicator, and the "unsaved changes"
// guard used before switching projects. Storage lives in core/persistence.js
// (IndexedDB); nothing is uploaded anywhere.
import { t, onLangChange } from '../i18n/i18n.js';
import { h, button, btnRow, hint } from './dom.js';
import { customDialog, confirmDialog, textPrompt, showMenu, toast } from './dialogs.js';
import { listProjects, clearRecovery } from '../core/persistence.js';
import { primaryKeyLabel } from './shortcuts.js';

const fmtDate = (ts) => { try { return new Date(ts).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return new Date(ts).toLocaleString(); } };

export function initProjects(editor) {
  // ---------- unsaved-changes guard ----------
  // Resolves true when the caller may proceed (saved or discarded), false on cancel.
  editor.guardUnsaved = async () => {
    if (!editor.dirty || !editor.project.nodes.length && !editor.project.clips.length) return true;
    const choice = await customDialog({
      title: t('unsaved.title'),
      body: t('unsaved.body', { name: editor.projectName || editor.defaultProjectName() }),
      buttons: [
        { label: t('btn.cancel'), value: () => 'cancel' },
        { label: t('unsaved.discard'), cls: 'danger', value: () => 'discard' },
        { label: t('unsaved.save'), primary: true, value: () => 'save' },
      ],
    });
    if (choice === 'save') return (await editor.saveLocal()) != null;
    return choice === 'discard';
  };

  // ---------- topbar: Projects menu + save state ----------
  const actions = document.getElementById('top-actions');
  const projBtn = h('button', { class: 'icon', id: 'btn-projects' });
  const state = h('button', { class: 'icon save-state', id: 'save-state' });
  actions.prepend(projBtn, state);
  state.addEventListener('click', () => editor.saveLocal());
  projBtn.addEventListener('click', async () => {
    const projects = await listProjects();
    const recent = projects.slice(0, 6);
    showMenu(projBtn, [
      { label: `${t('project.saveLocal')} (${primaryKeyLabel('file.save')})`, icon: '💾', action: () => editor.saveLocal() },
      { label: `${t('project.saveAs')}… (${primaryKeyLabel('file.saveAs')})`, icon: '💾', action: () => editor.saveLocal({ as: true }) },
      { sep: true },
      { head: t('project.openRecent') },
      ...(recent.length ? recent.map((p) => ({ label: p.name + (p.id === editor.projectId ? ' •' : ''), icon: '📄', disabled: p.id === editor.projectId, action: () => openProject(p.id) })) : [{ label: t('project.noRecent'), disabled: true, action: () => {} }]),
      { label: t('project.allProjects') + '…', icon: '📁', action: () => showProjectsDialog() },
      { sep: true },
      { label: t('project.new'), icon: '✦', action: async () => { if (await editor.guardUnsaved()) editor.newProject(); } },
      { label: t('start.import') + '…', icon: '⤓', action: () => importGiaGuarded() },
      { label: t('project.save'), icon: '⤒', action: () => editor.exportProjectFile?.() },
    ]);
  });
  const syncState = () => {
    projBtn.textContent = '📁 ' + t('project.projects');
    projBtn.title = t('tip.projects');
    const name = editor.projectName || editor.defaultProjectName();
    const hasContent = editor.project.nodes.length || editor.project.clips.length;
    if (!hasContent && !editor.projectId) { state.textContent = ''; state.hidden = true; }
    else {
      state.hidden = false;
      state.textContent = editor.dirty ? `● ${t('project.stateUnsaved')}` : `✓ ${t('project.stateSaved')}`;
      state.classList.toggle('dirty', !!editor.dirty);
      state.title = `${name} · ${editor.dirty ? t('project.stateUnsaved') : t('project.stateSaved')} · ${t('tip.saveState', { k: primaryKeyLabel('file.save') })}`;
    }
    document.title = `${hasContent ? name + (editor.dirty ? ' *' : '') + ' · ' : ''}${t('app.title')}`;
  };
  editor.on('dirty', syncState); editor.on('change', syncState); editor.on('projects', syncState);
  onLangChange(syncState);
  syncState();

  async function openProject(id) {
    if (id === editor.projectId && !editor.dirty) return;
    if (!(await editor.guardUnsaved())) return;
    if (await editor.loadLocal(id)) { editor.setMode('rig'); editor.emit('framed'); }
  }
  function importGiaGuarded() {
    const input = h('input', { type: 'file', accept: '.gia', style: 'display:none' });
    input.addEventListener('change', async () => { const f = input.files[0]; input.remove(); if (!f) return; if (await editor.guardUnsaved()) editor.readFile?.(f); });
    document.body.appendChild(input);
    input.click();
  }

  // ---------- project list (shared by start screen and dialog) ----------
  function renderList(container, projects, { onOpen, refresh }) {
    container.innerHTML = '';
    if (!projects.length) { container.append(h('div', { class: 'empty', text: t('start.empty') })); return; }
    for (const p of projects) {
      const meta = p.meta || {};
      const row = h('div', { class: 'proj-row' + (p.id === editor.projectId ? ' current' : '') },
        h('div', { class: 'proj-main' },
          h('div', { class: 'proj-name', text: p.name || t('project.untitled') }),
          h('div', { class: 'proj-sub', text: [p.giaName || '—', t('start.modified', { date: fmtDate(p.modifiedAt || p.createdAt) }), t('start.meta', { clips: meta.clips ?? 0, objects: meta.objects ?? 0 })].join(' · ') }),
        ),
        h('div', { class: 'proj-actions' },
          button(t('start.open'), () => onOpen(p.id), { cls: 'mini primary-mini' }),
          button('⋯', (e) => showMenu(e.currentTarget, [
            { label: t('start.rename'), action: async () => { const v = await textPrompt({ title: t('start.rename'), value: p.name }); if (v && await editor.renameLocal(p.id, v)) refresh(); } },
            { label: t('start.duplicate'), action: async () => { if (await editor.duplicateLocal(p.id)) refresh(); } },
            { sep: true },
            { label: t('start.delete'), action: async () => { if (await confirmDialog({ title: t('start.delete'), message: t('start.deleteConfirm', { name: p.name }), danger: true })) { await editor.deleteLocal(p.id); toast(t('toast.projectDeleted'), 'info'); refresh(); } } },
          ]), { cls: 'mini', tip: t('start.more') }),
        ),
      );
      row.addEventListener('dblclick', () => onOpen(p.id));
      container.append(row);
    }
  }

  // ---------- in-editor projects dialog ----------
  async function showProjectsDialog() {
    const body = h('div', { class: 'proj-browser' });
    const list = h('div', { class: 'proj-list' });
    body.append(hint(t('start.subtitle')), list);
    let closeDialog = null;
    const refresh = async () => renderList(list, await listProjects(), { onOpen: async (id) => { closeDialog?.(); await openProject(id); }, refresh });
    await refresh();
    const dlg = customDialog({ title: t('project.allProjects'), body, buttons: [
      { label: t('project.new'), value: () => 'new' },
      { label: t('start.import'), value: () => 'import' },
      { label: t('btn.close'), primary: true, value: () => 'close' },
    ] });
    closeDialog = () => document.querySelector('dialog[open]')?.dispatchEvent(new Event('cancel'));
    const r = await dlg;
    if (r === 'new') { if (await editor.guardUnsaved()) editor.newProject(); }
    else if (r === 'import') importGiaGuarded();
  }
  editor.showProjectsDialog = showProjectsDialog;

  // ---------- start screen (on launch) ----------
  editor.showStartScreen = async ({ projects, recovery }) => new Promise((resolve) => {
    const overlay = h('div', { id: 'start-screen' });
    const card = h('div', { class: 'start-card' });
    const close = (result) => { overlay.remove(); window.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close('continue'); } };
    window.addEventListener('keydown', onKey);
    card.append(h('div', { class: 'start-head' }, h('h2', { text: t('start.title') }), h('div', { class: 'hint', text: t('start.subtitle') })));
    if (recovery) {
      const rname = recovery.projectName || (recovery.giaName || '').replace(/\.gia$/i, '') || t('project.untitled');
      card.append(h('div', { class: 'recover-card' },
        h('div', { class: 'proj-main' }, h('div', { class: 'proj-name', text: t('start.recoverTitle') }), h('div', { class: 'proj-sub', text: t('start.recoverBody', { name: rname, date: fmtDate(recovery.savedAt || Date.now()) }) })),
        h('div', { class: 'proj-actions' },
          button(t('start.recover'), () => { editor.restoreSession(recovery); toast(t('toast.recovered'), 'info', 3000); close('recovered'); }, { cls: 'mini primary-mini' }),
          button(t('start.discard'), async () => { if (await confirmDialog({ title: t('start.discard'), message: t('start.discardConfirm'), danger: true })) { await clearRecovery(); card.querySelector('.recover-card')?.remove(); } }, { cls: 'mini danger' }),
        )));
    }
    card.append(h('div', { class: 'subhead', text: t('start.recent') }));
    const list = h('div', { class: 'proj-list' });
    card.append(list);
    const refresh = async () => renderList(list, await listProjects(), { onOpen: async (id) => { if (await editor.loadLocal(id)) { editor.setMode('rig'); close('opened'); } }, refresh });
    renderList(list, projects, { onOpen: async (id) => { if (await editor.loadLocal(id)) { editor.setMode('rig'); close('opened'); } }, refresh });
    const fileInput = h('input', { type: 'file', accept: '.gia', style: 'display:none' });
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) { close('import'); editor.readFile?.(f); } });
    card.append(btnRow(
      button(t('start.new'), () => { editor.newProject(); close('new'); }, { cls: 'mini' }),
      button(t('start.import'), () => fileInput.click(), { cls: 'mini' }),
      button(t('start.continue'), () => close('continue'), { cls: 'mini' }),
    ), fileInput);
    overlay.append(card);
    document.body.append(overlay);
  });
}
