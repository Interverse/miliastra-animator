// Contextual hints are derived from the current project, never remembered from the previous one.
// Covers the onboarding regressions: a new/emptied project always starts back at "Import a .gia",
// and export guidance only appears when this project is actually ready.
//   node tools/test-hints.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { workflowState, WORKFLOW_STEPS } from '../js/ui/workflow.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const gia = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));
const step = (ed) => workflowState(ed).step;

const loadModel = (ed) => ed.importGia(new Uint8Array(gia), 'Pantalone.gia');
const animate = (ed) => {
  ed.createClip();
  const obj = ed.project.nodes.find((n) => n.type === 'object');
  ed.setTime(0.5);
  ed.insertKeyframe([obj.id], ['pos']);
};
const exported = (ed) => { ed.lastReport = { parts: [], devices: 1, warnings: [] }; }; // what exportFile() records

// ---------- launch and New Project both start at "import" ----------
const ed = new Editor();
check('launch with no project: the next step is to import a .gia', step(ed) === 'import' && workflowState(ed).hasModel === false);
check('every workflow step has a hint string key', WORKFLOW_STEPS.every((s) => s === 'done' || typeof s === 'string'));

loadModel(ed);
check('importing a .gia clears the import hint', step(ed) !== 'import' && workflowState(ed).hasModel === true, step(ed));
check('a model with no bones and no animation asks for a rig (or direct animation)', step(ed) === 'rig');

ed.addBone(null);
check('with bones but no animation, the hint asks for an animation', step(ed) === 'animate');

animate(ed);
check('an animation with keyframes makes the project export-ready', step(ed) === 'export', step(ed));

exported(ed);
check('after exporting, the guidance stops', step(ed) === 'done');

// ---------- New Project must not inherit any of that ----------
ed.newProject();
check('New Project: the export hint is gone and the import hint is back', step(ed) === 'import');
check('New Project: the previous export report is cleared', ed.lastReport === null);
check('New Project: the transient status hint is cleared', ed.hint === '');
check('New Project: no leftover project content', ed.project.nodes.length === 0 && ed.project.clips.length === 0 && ed.giaBytes === null);

// a second project reaching the same point must ask to export again (not "done" from project 1)
loadModel(ed);
animate(ed);
check('the new project asks to export on its own merits, not the previous one', step(ed) === 'export', step(ed));

// ---------- undo / delete put the hint back ----------
ed.undo(); // remove the keyframe
check('undoing back to no keyframes removes the export hint', step(ed) !== 'export' && step(ed) !== 'done', step(ed));
while (ed.history.canRedo()) ed.redo();
check('redo returns to export-ready', step(ed) === 'export', step(ed));

const objectIds = ed.project.nodes.filter((n) => n.type === 'object').map((n) => n.id);
ed.deleteNodes(objectIds);
check('deleting the model brings back the import hint', step(ed) === 'import' && workflowState(ed).hasModel === false);
ed.undo();
check('undoing the deletion restores the model hint state', step(ed) !== 'import', step(ed));

// ---------- opening another project shows that project's state ----------
// applyRecord is the Open / Open Recent / Recover path; openProjectFile is the .json path.
const ready = ed.projectRecord();            // export-ready project
ed.newProject();
loadModel(ed);                                // incomplete: model only
const incomplete = ed.projectRecord();
check('an incomplete project reports its own step', step(ed) === 'rig');
ed.applyRecord(ready);
check('opening an export-ready project shows export guidance', step(ed) === 'export', step(ed));
ed.applyRecord(incomplete);
check('opening an incomplete project drops the export guidance again', step(ed) === 'rig', step(ed));
ed.applyRecord(ready); exported(ed);
ed.openProjectFile(ed.projectFileJSON());
check('opening a project .json re-derives the step (export report not carried over)', step(ed) === 'export' && ed.lastReport === null, step(ed));

// ---------- repeated switching never leaks ----------
let leaked = null;
for (let i = 0; i < 4; i++) {
  ed.applyRecord(ready); exported(ed);
  if (step(ed) !== 'done') leaked = `ready pass ${i}: ${step(ed)}`;
  ed.newProject();
  if (step(ed) !== 'import' || ed.lastReport !== null) leaked = `new pass ${i}: ${step(ed)}`;
  ed.applyRecord(incomplete);
  if (step(ed) !== 'rig') leaked = `incomplete pass ${i}: ${step(ed)}`;
}
check('repeated project switching never leaks hint state', leaked === null, leaked || '');

// project recovery goes through the same path as opening
ed.applyRecord(incomplete);
const rec = ed.recoveryRecord();
ed.applyRecord(ready); exported(ed);
ed.restoreSession(rec);
check('recovering a session re-derives the hint from the recovered project', step(ed) === 'rig' && ed.lastReport === null, step(ed));

// ---------- the hint strings exist in every language ----------
const en = (await import('../js/i18n/locales/en.js')).default;
const LOCALES = ['en', 'de', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'tr', 'vi', 'zhs', 'zht'];
const HINT_KEYS = [...WORKFLOW_STEPS.filter((s) => s !== 'done').map((s) => 'guide.next.' + s), 'viewport.empty', 'viewport.emptyLead', 'viewport.emptyHint', 'viewport.import'];
check('English has a hint for every step plus the empty-viewport strings', HINT_KEYS.every((k) => en[k]), HINT_KEYS.filter((k) => !en[k]).join(','));
for (const l of LOCALES) {
  const d = (await import(`../js/i18n/locales/${l}.js`)).default;
  check(`${l}: hint strings present`, HINT_KEYS.every((k) => d[k]), HINT_KEYS.filter((k) => !d[k]).join(','));
}

// ---------- no stored hint string anywhere ----------
const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const bar = src('js/ui/project-bar.js'), main = src('js/main.js');
check('the hint UI derives from workflowState instead of a stored hint', bar.includes('workflowState(editor)') && main.includes('workflowState(editor).hasModel') && !/currentHint|lastHint|hintState/.test(bar + main + src('js/ui/workflow.js')));
check('export progress is cleared by the shared project-switch path', /beginProjectSwitch\(\)[\s\S]{0,400}this\.lastReport = null;/.test(src('js/ui/editor.js')));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall hint checks passed');
process.exit(failures ? 1 : 0);
