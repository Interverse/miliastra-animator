// Local projects UI: Recent Projects start screen, in-editor Projects menu and
// browser dialog, the saved / unsaved indicator, and the "unsaved changes"
// guard used before switching projects. Storage lives in core/persistence.js
// (IndexedDB); nothing is uploaded anywhere.
import { t, onLangChange, LANGS, currentLang, setLanguage } from '../i18n/i18n.js';
import { h, button, btnRow, hint, selectInput } from './dom.js';
import { customDialog, confirmDialog, textPrompt, showMenu, toast } from './dialogs.js';
import { listProjects, clearRecovery } from '../core/persistence.js';
import { primaryKeyLabel } from './shortcuts.js';
import { showGiaHelp } from './gia-help.js';

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
      { label: t('project.open') + '…', icon: '⤓', action: () => importProjectGuarded() },
      { label: t('project.save'), icon: '⤒', action: () => editor.exportProjectFile?.() },
    ]);
  });
  const syncState = () => {
    projBtn.textContent = '📁';
    projBtn.title = `${t('project.projects')} · ${t('tip.projects')}`;
    projBtn.setAttribute('aria-label', t('project.projects'));
    const name = editor.projectName || editor.defaultProjectName();
    const hasContent = editor.project.nodes.length || editor.project.clips.length;
    if (!hasContent && !editor.projectId) { state.textContent = ''; state.hidden = true; }
    else {
      state.hidden = false;
      state.textContent = editor.dirty ? '●' : '✓';
      state.classList.toggle('dirty', !!editor.dirty);
      state.title = `${name} · ${editor.dirty ? t('project.stateUnsaved') : t('project.stateSaved')} · ${t('tip.saveState', { k: primaryKeyLabel('file.save') })}`;
      state.setAttribute('aria-label', editor.dirty ? t('project.stateUnsaved') : t('project.stateSaved'));
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
  // Project file (.json exported from this editor). Replaces the open project, so the
  // unsaved-changes guard runs first; the picker itself is the shared one from panels-left.
  async function importProjectGuarded() {
    if (!(await editor.guardUnsaved())) return;
    editor.pickProjectFile?.();
  }
  editor.importProjectGuarded = importProjectGuarded;
  // Samples ship with the site (samples/): a rigged, animated Bangboo project and its .gia.
  const SAMPLE_PROJECT = 'samples/Bangboo.animator.json', SAMPLE_GIA = 'samples/Bangboo.gia';
  async function openSampleProject() {
    let text;
    try { const r = await fetch(SAMPLE_PROJECT); if (!r.ok) throw new Error(r.status); text = await r.text(); }
    catch (e) { console.error(e); toast(t('toast.sampleFailed'), 'error', 6000); return false; }
    try { editor.openProjectFile(text); } catch (e) { console.error(e); toast(t('toast.projectOpenFailed'), 'error'); return false; }
    editor.setMode('animate');
    toast(t('toast.projectOpened'), 'success');
    return true;
  }
  function downloadSampleGia() {
    const a = h('a', { href: SAMPLE_GIA, download: 'Bangboo.gia', style: 'display:none' });
    document.body.appendChild(a); a.click(); a.remove();
  }
  editor.openSampleProject = async () => { if (await editor.guardUnsaved()) return openSampleProject(); return false; };
  editor.downloadSampleGia = downloadSampleGia;

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
      { label: t('project.open') + '…', value: () => 'importProject' },
      { label: t('btn.close'), primary: true, value: () => 'close' },
    ] });
    closeDialog = () => document.querySelector('dialog[open]')?.dispatchEvent(new Event('cancel'));
    const r = await dlg;
    if (r === 'new') { if (await editor.guardUnsaved()) editor.newProject(); }
    else if (r === 'import') importGiaGuarded();
    else if (r === 'importProject') importProjectGuarded();
  }
  editor.showProjectsDialog = showProjectsDialog;

  // ---------- start screen (on launch) ----------
  editor.showStartScreen = async ({ projects, recovery }) => new Promise((resolve) => {
    const overlay = h('div', { id: 'start-screen' });
    const card = h('div', { class: 'start-card' });
    let offLang = null;
    const close = (result) => { offLang?.(); overlay.remove(); window.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close('continue'); } };
    window.addEventListener('keydown', onKey);
    const openSaved = async (id) => { if (await editor.loadLocal(id)) { editor.setMode('rig'); close('opened'); } };
    // file pickers live outside the re-rendered card so a language switch never drops them
    const fileInput = h('input', { type: 'file', accept: '.gia', style: 'display:none' });
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) { close('import'); editor.readFile?.(f); } });
    const projInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
    projInput.addEventListener('change', async () => {
      const f = projInput.files[0]; projInput.value = '';
      if (!f) return;
      try { editor.openProjectFile(await f.text()); toast(t('toast.projectOpened')); close('opened'); }
      catch { toast(t('toast.projectOpenFailed'), 'error'); }
    });
    // Two ways to start, each in its own box: from a model (.gia: import yours or the sample
    // model, plus how to export one from Miliastra) or from the finished sample project.
    const startCard = (icon, title, text, ...buttons) => h('div', { class: 'start-option' },
      h('div', { class: 'start-option-head' }, h('span', { class: 'start-option-icon', text: icon, 'aria-hidden': 'true' }), h('div', { class: 'proj-name', text: title })),
      h('div', { class: 'proj-sub', text }),
      h('div', { class: 'start-option-actions' }, ...buttons));
    // The whole card is rebuilt from current strings, so switching language here (or anywhere)
    // updates it at once. Recent projects are re-read; a discarded recovery stays discarded.
    const render = (list) => {
      card.innerHTML = '';
      const langSel = selectInput(LANGS.map((l) => ({ value: l.code, label: l.name })), currentLang(), (v) => setLanguage(v, true));
      langSel.classList.add('start-lang');
      langSel.title = t('settings.language');
      langSel.setAttribute('aria-label', t('settings.language'));
      card.append(h('div', { class: 'start-head' },
        h('div', { class: 'start-head-text' }, h('h2', { text: t('start.title') }), h('div', { class: 'hint', text: t('start.subtitle') })),
        langSel));
      if (recovery) {
        const rname = recovery.projectName || (recovery.giaName || '').replace(/\.gia$/i, '') || t('project.untitled');
        card.append(h('div', { class: 'recover-card' },
          h('div', { class: 'proj-main' }, h('div', { class: 'proj-name', text: t('start.recoverTitle') }), h('div', { class: 'proj-sub', text: t('start.recoverBody', { name: rname, date: fmtDate(recovery.savedAt || Date.now()) }) })),
          h('div', { class: 'proj-actions' },
            button(t('start.recover'), () => { editor.restoreSession(recovery); toast(t('toast.recovered'), 'info', 3000); close('recovered'); }, { cls: 'mini primary-mini' }),
            button(t('start.discard'), async () => { if (await confirmDialog({ title: t('start.discard'), message: t('start.discardConfirm'), danger: true })) { await clearRecovery(); recovery = null; card.querySelector('.recover-card')?.remove(); } }, { cls: 'mini danger' }),
          )));
      }
      card.append(h('div', { class: 'subhead', text: t('start.recent') }));
      const listEl = h('div', { class: 'proj-list' });
      card.append(listEl);
      const refresh = async () => renderList(listEl, await listProjects(), { onOpen: openSaved, refresh });
      renderList(listEl, list, { onOpen: openSaved, refresh });
      card.append(h('div', { class: 'start-options' },
        startCard('▣', t('start.giaHead'), t('start.giaHint'),
          button(t('start.import') + '…', () => fileInput.click(), { cls: 'mini primary-mini', tip: t('tip.start.importGia') }),
          button(t('start.sampleGia'), () => downloadSampleGia(), { cls: 'mini', tip: t('tip.start.sampleGia') }),
          button(t('start.giaHow'), () => showGiaHelp(null), { cls: 'mini link-btn', tip: t('giaHelp.title') })),
        startCard('▶', t('start.sampleHead'), t('start.sampleHint'),
          button(t('start.sampleOpen'), async () => { if (await openSampleProject()) close('opened'); }, { cls: 'mini primary-mini', tip: t('tip.start.sampleOpen') })),
      ));
      card.append(h('div', { class: 'start-actions' },
        button(t('start.new'), () => { editor.newProject(); close('new'); }, { cls: 'mini' }),
        button(t('project.open') + '…', () => projInput.click(), { cls: 'mini', tip: t('tip.start.importProject') }),
        h('span', { class: 'spacer' }),
        button(t('start.continue'), () => close('continue'), { cls: 'mini' }),
      ));
    };
    render(projects);
    offLang = onLangChange(async () => { render(await listProjects()); card.querySelector('.start-lang')?.focus(); });
    overlay.append(card, fileInput, projInput);
    document.body.append(overlay);
  });
}
