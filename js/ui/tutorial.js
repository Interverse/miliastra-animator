// Step-by-step "Getting started" tour: spotlights the parts of the interface
// in the order a first animation is made. Launched from the floating button;
// a one-time welcome bubble points new visitors at it.
import { t, onLangChange } from '../i18n/i18n.js';
import { loadPrefs, updatePrefs } from '../core/persistence.js';

const STEPS = [
  { id: 'panel-project', key: 'tut.import', open: true, mode: 'rig' },
  { id: 'panel-outliner', key: 'tut.bones', open: true, mode: 'rig' },
  { id: 'panel-rigging', key: 'tut.rigging', open: true, mode: 'rig' },
  { id: 'panel-clips', key: 'tut.clip', open: true, mode: 'animate' },
  { id: 'timeline', key: 'tut.keys', mode: 'animate' },
  { id: 'tl-head', key: 'tut.preview', mode: 'animate' },
  { id: 'panel-export', key: 'tut.export', open: true, mode: 'export' },
  { id: 'btn-export', key: 'tut.download', mode: 'export' },
  { id: 'vp-toolbar', key: 'tut.toolbar' },
  { id: 'nav-widget', key: 'tut.nav' },
];

export function initTutorial(editor) {
  const btn = document.getElementById('btn-tutorial');
  let overlay = null, steps = [], idx = 0;
  const seen = () => !!loadPrefs().tutorialSeen;
  const markSeen = () => updatePrefs({ tutorialSeen: true });

  function showWelcome() {
    const bub = document.createElement('div');
    bub.id = 'tut-welcome';
    const msg = document.createElement('span'); msg.textContent = t('tut.welcome');
    const start = document.createElement('button'); start.className = 'mini'; start.textContent = t('tut.start');
    start.addEventListener('click', () => { bub.remove(); startTour(); });
    const x = document.createElement('button'); x.className = 'mini tut-x'; x.textContent = '✕';
    x.addEventListener('click', () => { markSeen(); bub.remove(); });
    bub.append(msg, start, x);
    document.getElementById('viewport').appendChild(bub);
  }
  const visible = (el) => el && el.offsetParent !== null;
  function startTour() {
    markSeen(); endTour();
    steps = STEPS.slice();
    idx = 0;
    const root = document.createElement('div'); root.id = 'tut-overlay';
    const hole = document.createElement('div'); hole.className = 'tut-hole';
    const pop = document.createElement('div'); pop.className = 'tut-pop';
    root.append(hole, pop);
    document.body.appendChild(root);
    overlay = { root, hole, pop };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', position);
    renderStep();
  }
  function endTour() {
    overlay?.root.remove(); overlay = null;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', position);
  }
  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') endTour();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
    else if (e.key === 'ArrowLeft') back();
    e.stopPropagation();
  }
  const next = () => { if (idx >= steps.length - 1) endTour(); else { idx++; renderStep(); } };
  const back = () => { if (idx > 0) { idx--; renderStep(); } };
  function renderStep() {
    if (!overlay) return;
    const s = steps[idx];
    if (s.mode) editor.setMode(s.mode);
    const el = document.getElementById(s.id);
    if (!el || !visible(el)) { if (idx < steps.length - 1) return next(); return endTour(); }
    if (s.open && el.tagName === 'DETAILS') el.open = true;
    el.scrollIntoView({ block: 'nearest' });
    const { pop } = overlay;
    pop.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = t(s.key + '.t');
    const body = document.createElement('div'); body.className = 'tut-body'; body.textContent = t(s.key + '.b');
    const bar = document.createElement('div'); bar.className = 'tut-bar';
    const prog = document.createElement('span'); prog.className = 'tut-prog'; prog.textContent = `${idx + 1} / ${steps.length}`;
    const bBack = document.createElement('button'); bBack.className = 'mini'; bBack.textContent = t('tut.back'); bBack.disabled = idx === 0; bBack.addEventListener('click', back);
    const bNext = document.createElement('button'); bNext.className = 'mini tut-next'; bNext.textContent = t(idx === steps.length - 1 ? 'tut.done' : 'tut.next'); bNext.addEventListener('click', next);
    const bSkip = document.createElement('button'); bSkip.className = 'mini tut-x'; bSkip.textContent = t('tut.skip'); bSkip.addEventListener('click', endTour);
    bar.append(prog, bBack, bNext, bSkip);
    pop.append(h, body, bar);
    requestAnimationFrame(position);
  }
  function position() {
    if (!overlay) return;
    const el = document.getElementById(steps[idx].id);
    if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6;
    const { hole, pop } = overlay;
    hole.style.left = r.left - pad + 'px'; hole.style.top = r.top - pad + 'px';
    hole.style.width = r.width + pad * 2 + 'px'; hole.style.height = r.height + pad * 2 + 'px';
    const pw = Math.min(340, window.innerWidth - 24);
    pop.style.width = pw + 'px';
    const cx = r.left + r.width / 2;
    let left = cx < window.innerWidth / 2 ? r.right + 14 : r.left - pw - 14;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    const ph = pop.offsetHeight || 160;
    let top = r.top;
    if (r.height > window.innerHeight * 0.6) top = Math.max(12, r.top + 40);
    top = Math.max(12, Math.min(top, window.innerHeight - ph - 12));
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  btn.addEventListener('click', () => { document.getElementById('tut-welcome')?.remove(); startTour(); });
  onLangChange(() => { if (overlay) renderStep(); });
  if (!seen()) showWelcome();
  return { start: startTour };
}
