// Editable display models:  node tools/test-display-model.mjs
// The display offset (node.display: pos/rot/scale) is a visualization layer:
// it composes with the object's world transform for drawing, is undoable as
// one step per edit, persists in the project file, and never changes the
// object transform, keys, bones, devices or the exported .gia.
import { readFileSync } from 'node:fs';
import { Editor, displayOf, hasDisplayOffset } from '../js/ui/editor.js';
import { exportGia } from '../js/gia/gia-export.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { quat, v3, xf } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;

const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
const ed = new Editor();
ed.openProjectFile(JSON.stringify(j));
const p = ed.project;
const body = p.nodes.find((n) => n.type === 'object' && n.name === 'Body');
ed.select(body.id);
const before = { project: JSON.stringify(p), gia: Buffer.from(exportGia(p, gia).bytes) };
const worldBefore = evaluatePose(p, p.activeClipId, ed.time).world.get(body.id);

// ---------- defaults / mode ----------
check('objects start with the identity display offset', !hasDisplayOffset(body) && v3.dist(displayOf(body).pos, [0, 0, 0]) === 0 && displayOf(body).scale.join() === '1,1,1');
check('Scale tool is refused outside display-edit mode', (ed.setTool('scale'), ed.tool !== 'scale'));
ed.setDisplayEdit(true);
check('display-edit mode on, Move tool active', ed.displayEdit && ed.tool === 'move' && ed.displayEditNode() === body);
ed.setTool('scale');
check('Scale tool available in display-edit mode', ed.tool === 'scale');

// ---------- numeric edits ----------
const undo0 = ed.history.undoStack.length;
ed.setDisplayTransform(body.id, { pos: [0.1, 0.2, -0.3] });
ed.setDisplayTransform(body.id, { rot: quat.fromEulerDeg([0, 45, 0]) });
ed.setDisplayTransform(body.id, { scale: [2, 0.5, 1.5] });
const d = displayOf(body);
check('offset / rotation / scale stored on the node', v3.dist(d.pos, [0.1, 0.2, -0.3]) < 1e-9 && ang(d.rot, quat.fromEulerDeg([0, 45, 0])) < 1e-9 && d.scale.join() === '2,0.5,1.5');
check('each numeric edit is one undo step', ed.history.undoStack.length === undo0 + 3 && ed.history.undoLabel() === 'Display model');
const worldAfter = evaluatePose(p, p.activeClipId, ed.time).world.get(body.id);
check('the object world transform is unchanged', v3.dist(worldAfter.pos, worldBefore.pos) < 1e-12 && ang(worldAfter.rot, worldBefore.rot) < 1e-12);
check('keys, bones, settings untouched (project equal apart from display data)', (() => { const strip = (s) => JSON.stringify(JSON.parse(s), (k, v) => (k === 'display' ? undefined : v)); return strip(JSON.stringify(p)) === strip(before.project); })());
check('exported .gia is byte-identical', Buffer.compare(Buffer.from(exportGia(p, gia).bytes), before.gia) === 0);

// ---------- display frame composes with the object world ----------
const f = ed.displayFrameWorld(body.id);
const expected = xf.compose(worldAfter, { pos: [0.1, 0.2, -0.3], rot: quat.fromEulerDeg([0, 45, 0]) });
check('display frame = object world ∘ display offset', v3.dist(f.pos, expected.pos) < 1e-9 && ang(f.rot, expected.rot) < 1e-9);
// gizmo path: a world transform of the display frame becomes a local offset
const target = { pos: v3.add(f.pos, [0.5, 0, 0]), rot: quat.norm(quat.mul(quat.fromEulerDeg([0, 0, 30]), f.rot)) };
ed.setDisplayWorld(body.id, target);
const f2 = ed.displayFrameWorld(body.id);
check('setDisplayWorld round-trips through the object frame', v3.dist(f2.pos, target.pos) < 1e-9 && ang(f2.rot, target.rot) < 1e-9);
check('object still unchanged after gizmo-style edit', v3.dist(evaluatePose(p, p.activeClipId, ed.time).world.get(body.id).pos, worldBefore.pos) < 1e-12);

// ---------- drag = one history step, cancel restores ----------
const undo1 = ed.history.undoStack.length;
ed.beginInteraction('gizmo-move', { finish: () => ed.commit('Display model'), cancel: () => ed.restoreCommitted() });
for (let i = 1; i <= 5; i++) ed.setDisplayTransform(body.id, { scale: [1 + i * 0.1, 1, 1] }, { commit: false });
ed.finishInteraction();
check('a drag with many transient updates is a single undo step', ed.history.undoStack.length === undo1 + 1 && Math.abs(displayOf(body).scale[0] - 1.5) < 1e-9);
const posBefore = displayOf(ed.project.nodes.find((n) => n.id === body.id)).pos.slice();
ed.beginInteraction('gizmo-move', { finish: () => ed.commit('Display model'), cancel: () => ed.restoreCommitted() });
ed.setDisplayTransform(body.id, { pos: [9, 9, 9] }, { commit: false });
ed.cancelInteraction();
check('Escape restores the pre-drag display offset', v3.dist(displayOf(ed.project.nodes.find((n) => n.id === body.id)).pos, posBefore) < 1e-9);

// ---------- undo / redo ----------
const scaleNow = displayOf(ed.project.nodes.find((n) => n.id === body.id)).scale.slice();
ed.undo();
check('undo reverts the last display edit', displayOf(ed.project.nodes.find((n) => n.id === body.id)).scale.join() !== scaleNow.join());
ed.redo();
check('redo restores it', displayOf(ed.project.nodes.find((n) => n.id === body.id)).scale.join() === scaleNow.join());

// ---------- persistence ----------
const json = ed.projectFileJSON();
const ed2 = new Editor();
ed2.openProjectFile(json);
const b2 = ed2.project.nodes.find((n) => n.name === 'Body' && n.type === 'object');
check('display offset survives a project file round trip', hasDisplayOffset(b2) && displayOf(b2).scale.join() === scaleNow.join());
check('the reloaded project exports the same .gia', Buffer.compare(Buffer.from(exportGia(ed2.project, gia).bytes), before.gia) === 0);
const rec = ed.projectRecord();
check('local project record carries the display data', JSON.stringify(rec.project).includes('"display"'));

// ---------- reset ----------
ed.resetDisplay(body.id);
check('reset restores the reference geometry (identity offset)', !hasDisplayOffset(ed.project.nodes.find((n) => n.id === body.id)) && ed.history.undoLabel() === 'Reset display model');

// ---------- leaving the mode ----------
ed.setDisplayEdit(false);
check('leaving display-edit switches Scale back to Move', !ed.displayEdit && ed.tool === 'move');
ed.newProject();
check('a new project starts outside display-edit mode', !ed.displayEdit);

// ---------- Space: context-aware transform tool cycling ----------
{
  const e = new Editor();
  e.openProjectFile(JSON.stringify(j));
  const obj = e.project.nodes.find((n) => n.type === 'object');
  const bone = e.project.nodes.find((n) => n.type === 'bone');
  e.select(obj.id); e.setTool('move');
  const hist = e.history.undoStack.length;
  e.setSpace('local');
  check('object: Move → Rotate → Move', e.cycleTool() === 'rotate' && e.cycleTool() === 'move' && e.availableTools().join() === 'move,rotate');
  e.select(bone.id); e.setTool('move');
  check('bone: Move → Rotate → Move', e.cycleTool() === 'rotate' && e.cycleTool() === 'move');
  e.select(obj.id); e.setDisplayEdit(true); e.setTool('move');
  check('display model (root): Move → Rotate → Scale → Move', e.cycleTool() === 'rotate' && e.cycleTool() === 'scale' && e.cycleTool() === 'move' && e.availableTools().join() === 'move,rotate,scale');
  const parts = e.displayParts(obj.id);
  e.selectDisplayParts([parts[0].id]);
  check('one display part: cycle includes Scale', e.cycleTool() === 'rotate' && e.cycleTool() === 'scale');
  e.selectDisplayParts([parts[0].id, parts[1].id]); e.setTool('move');
  check('several display parts: cycle includes Scale', e.cycleTool() === 'rotate' && e.cycleTool() === 'scale' && e.cycleTool() === 'move');
  e.setTool('scale');
  e.select(bone.id);
  check('Scale active, then a bone is selected → next valid tool (Move)', e.tool === 'move' && e.availableTools().join() === 'move,rotate');
  e.select(obj.id); e.setTool('scale'); e.setDisplayEdit(false);
  check('Scale active, display editing turned off → Move', e.tool === 'move');
  e.setTool('select');
  check('from Select, Space goes to the first available tool', e.cycleTool() === 'move');
  check('cycling never touches history or the axis mode', e.history.undoStack.length === hist && e.space === 'local');
  e.select(obj.id); e.setDisplayEdit(true); e.selectDisplayParts([parts[0].id]); e.setTool('rotate'); e.cycleTool();
  check('cycling keeps the part selection', e.displaySel.has(parts[0].id) && e.tool === 'scale' && e.active === obj.id);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
