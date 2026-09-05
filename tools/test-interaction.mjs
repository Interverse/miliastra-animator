// Interaction state machine + timeline/transform synchronization (no browser):
//   node tools/test-interaction.mjs
// Covers the sequences that used to leave the editor stuck or made a bone
// "impossible to rotate" at frames without a key.
import { Editor } from '../js/ui/editor.js';
import { createNode } from '../js/scene/scene.js';
import { createClip, insertKey, track, activeClip } from '../js/anim/clips.js';
import { getNode } from '../js/scene/scene.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const rotY = (deg) => quat.fromEulerDeg([0, deg, 0]);
const near = (a, b) => quat.angle(a, b) < 1e-6;

function makeScene() {
  const ed = new Editor();
  const p = ed.project;
  const a = createNode(p, 'bone', { name: 'A', pos: [0, 1, 0], rot: [0, 0, 0, 1], length: 0.4 });
  const b = createNode(p, 'bone', { name: 'B', parent: a.id, pos: [0, 0.4, 0], rot: [0, 0, 0, 1], length: 0.3 });
  const c = createNode(p, 'bone', { name: 'C', parent: b.id, pos: [0, 0.3, 0], rot: [0, 0, 0, 1], length: 0.2 });
  const clip = createClip(p, 'Walk', 2);
  p.activeClipId = clip.id;
  insertKey(clip, a.id, 'rot', 0, rotY(0)); insertKey(clip, a.id, 'rot', 1, rotY(90));
  p.settings.autoKey = false;
  ed.history.reset(p);
  return { ed, p, a, b, c, clip };
}

// ---------- 1. state machine ----------
{
  const { ed } = makeScene();
  const log = [];
  ed.beginInteraction('gizmo-rotate', { finish: () => log.push('finish1'), cancel: () => log.push('cancel1') });
  check('interaction registered', ed.interactionKind === 'gizmo-rotate');
  ed.beginInteraction('timeline-scrub', { finish: () => log.push('finish2') });
  check('starting a new interaction finishes the previous one', log.join() === 'finish1' && ed.interactionKind === 'timeline-scrub');
  check('endInteraction with a different kind is ignored', ed.endInteraction('gizmo-move') === false && ed.interactionKind === 'timeline-scrub');
  check('endInteraction with the right kind returns to idle', ed.endInteraction('timeline-scrub') === true && ed.interactionKind === 'idle');
  ed.beginInteraction('gizmo-move', { finish: () => log.push('finish3'), cancel: () => log.push('cancel3') });
  ed.cancelInteraction();
  check('cancel runs the cancel callback exactly once', log.filter((x) => x === 'cancel3').length === 1 && !log.includes('finish3') && ed.interactionKind === 'idle');
  check('finish on idle is a no-op', ed.finishInteraction() === false);
  // re-entrancy: a finish callback that starts another interaction cannot loop
  let depth = 0;
  ed.beginInteraction('gizmo-rotate', { finish: () => { depth++; if (depth < 5) ed.finishInteraction(); } });
  ed.finishInteraction();
  check('finish callbacks cannot re-enter', depth === 1 && ed.interactionKind === 'idle');
}

// ---------- 2. selection / tool / time changes end a transform ----------
{
  const { ed, a, b } = makeScene();
  let finished = 0;
  const start = () => ed.beginInteraction('gizmo-rotate', { finish: () => finished++ });
  start(); ed.select(b.id);
  check('selecting another bone finishes the transform', finished === 1 && ed.interactionKind === 'idle' && ed.active === b.id);
  start(); ed.setTool('move');
  check('switching tools finishes the transform', finished === 2 && ed.tool === 'move');
  start(); ed.setTool('move');
  check('re-selecting the same tool keeps the transform', finished === 2 && ed.interactionKind === 'gizmo-rotate');
  ed.setSpace('local');
  check('Local/World switch finishes the transform', finished === 3);
  start(); ed.setTime(0.5);
  check('frame change finishes the transform', finished === 4 && Math.abs(ed.time - 0.5) < 1e-9);
  ed.beginInteraction('timeline-scrub', { finish: () => finished++ });
  ed.setTime(0.7);
  check('timeline scrubbing keeps its own interaction alive', finished === 4 && ed.interactionKind === 'timeline-scrub');
  ed.endInteraction();
  start(); ed.undo();
  check('undo finishes the transform first', finished === 5);
  ed.beginInteraction('viewport-orbit', { finish: () => finished++ });
  ed.select(a.id);
  check('selection leaves a camera drag alone', finished === 5 && ed.interactionKind === 'viewport-orbit');
  ed.endInteraction();
}

// ---------- 3. playback pauses when editing begins ----------
{
  const { ed, a } = makeScene();
  ed.play();
  check('playing', ed.playing);
  ed.beginInteraction('gizmo-rotate');
  check('gizmo drag pauses playback', !ed.playing);
  ed.endInteraction();
  ed.play(); ed.tick(0.1);
  const t0 = ed.time;
  ed.setNodeLocal(a.id, { rot: rotY(10) }, { commit: false });
  check('numeric/transient edit pauses playback and keeps the playhead', !ed.playing && Math.abs(ed.time - t0) < 1e-9);
}

// ---------- 4. unkeyed frame, Auto Key off: pose edit must show and be keyable ----------
{
  const { ed, p, a, b, clip } = makeScene();
  ed.setTime(0.5);
  const committed = JSON.stringify(p);
  const evaluated = ed.currentLocal(a.id).rot;
  check('frame 0.5 interpolates the keys', Math.abs(quat.angle(evaluated, rotY(45))) < 1e-6);
  ed.setNodeLocal(a.id, { rot: rotY(20) }, { commit: false });
  check('rotation at an unkeyed frame is applied (override)', near(ed.currentLocal(a.id).rot, rotY(20)) && ed.hasPoseOverride(a.id, 'rot'));
  check('the world pose reflects it', near(ed.pose().world.get(a.id).rot, rotY(20)));
  check('project data untouched (no key, no base change)', JSON.stringify(ed.project) === committed);
  ed.setNodeLocal(a.id, { rot: rotY(30) });
  check('further edits update the same override', near(ed.currentLocal(a.id).rot, rotY(30)));
  check('descendants follow the overridden pose', Math.abs(quat.angle(ed.pose().world.get(b.id).rot, rotY(30))) < 1e-6);
  // undo/redo of the unkeyed edit itself
  check('the unkeyed edit is an undo step', ed.history.canUndo() && ed.history.undoLabel() !== 'init');
  ed.undo();
  check('undo moves the bone back to the evaluated pose', !ed.hasPoseOverride(a.id) && Math.abs(quat.angle(ed.currentLocal(a.id).rot, rotY(45))) < 1e-6);
  ed.redo();
  check('redo restores the unkeyed pose', ed.hasPoseOverride(a.id) && near(ed.currentLocal(a.id).rot, rotY(30)));
  check('unkeyed edits never dirty the project', !ed.dirty);
  ed.setTime(0.25); ed.undo(); ed.redo();
  check('redo at another frame does not resurface the frame-0.5 pose', !ed.hasPoseOverride(a.id) && Math.abs(quat.angle(ed.currentLocal(a.id).rot, rotY(22.5))) < 1e-6);
  ed.setTime(0.5);
  check('returning to the frame after a frame change keeps it discarded', !ed.hasPoseOverride(a.id) && Math.abs(quat.angle(ed.currentLocal(a.id).rot, rotY(45))) < 1e-6);
  ed.setNodeLocal(a.id, { rot: rotY(30) });
  ed.insertKeyframe([a.id], ['rot']);
  check('Insert Keyframe turns the override into a key', ed.hasKeyAt(a.id, 'rot') && near(track(activeClip(ed.project), a.id).rot.find((k) => Math.abs(k.t - 0.5) < 1e-6).v, rotY(30)) && !ed.hasPoseOverride(a.id));
  check('undo removes that key again', (ed.undo(), !ed.hasKeyAt(a.id, 'rot')));
  check('undo keeps the playhead where it was', Math.abs(ed.time - 0.5) < 1e-9);
  ed.setNodeLocal(a.id, { rot: rotY(60) });
  ed.setTime(0.75);
  check('changing frame discards the unkeyed pose', !ed.hasPoseOverride(a.id) && Math.abs(quat.angle(ed.currentLocal(a.id).rot, rotY(67.5))) < 1e-6);
  // rotate at frame 0 (keyed) → key updates directly
  ed.setTime(0);
  ed.setNodeLocal(a.id, { rot: rotY(-15) });
  check('editing on a keyed frame updates the key', near(track(activeClip(ed.project), a.id).rot[0].v, rotY(-15)) && !ed.hasPoseOverride(a.id));
  // unkeyed channel: base edit as before
  ed.setNodeLocal(b.id, { rot: rotY(5) });
  check('unanimated channel edits the base transform', near(getNode(ed.project, b.id).rot, rotY(5)) && !ed.hasPoseOverride(b.id));
  // overrides and playback / clip switch
  ed.setTime(0.5); ed.setNodeLocal(a.id, { rot: rotY(1) });
  ed.play(); ed.tick(0.05);
  check('playback discards unkeyed pose edits', !ed.hasPoseOverride(a.id));
  ed.pause(); ed.setTime(0.5); ed.setNodeLocal(a.id, { rot: rotY(2) });
  const clip2 = createClip(p, 'Other', 1); ed.setActiveClip(clip2.id);
  check('switching clips discards unkeyed pose edits', !ed.hasPoseOverride(a.id));
}

// ---------- 5. Auto Key on at multiple frames ----------
{
  const { ed, a, clip } = makeScene();
  ed.project.settings.autoKey = true;
  for (const [tm, deg] of [[0.25, 10], [0.5, 20], [0.75, 30]]) { ed.setTime(tm); ed.setNodeLocal(a.id, { rot: rotY(deg) }); }
  const tr = track(clip, a.id).rot;
  check('auto key creates a key per frame', tr.length === 5 && [0.25, 0.5, 0.75].every((tm) => tr.some((k) => Math.abs(k.t - tm) < 1e-6)));
  check('no overrides linger with auto key', !ed.hasPoseOverride(a.id));
  check('each frame evaluates its own key', (ed.setTime(0.5), near(ed.currentLocal(a.id).rot, rotY(20))));
  ed.undo(); ed.undo(); ed.undo();
  check('undo x3 removes the three keys', track(activeClip(ed.project), a.id).rot.length === 2);
  ed.redo(); ed.redo(); ed.redo();
  check('redo x3 restores them', track(activeClip(ed.project), a.id).rot.length === 5 && (ed.setTime(0.75), near(ed.currentLocal(a.id).rot, rotY(30))));
}

// ---------- 6. Escape restores the drag-start pose ----------
{
  const { ed, p, a } = makeScene();
  ed.project.settings.autoKey = true;
  ed.history.reset(p); // the Auto Key setting is part of the committed state
  ed.setTime(0.5);
  const committed = JSON.stringify(p);
  ed.beginInteraction('gizmo-rotate', { cancel: () => ed.restoreCommitted() });
  ed.setNodeLocal(a.id, { rot: rotY(70) }, { commit: false });
  check('drag applied a key transiently', ed.hasKeyAt(a.id, 'rot'));
  ed.cancelInteraction();
  check('cancel restores the exact committed state', JSON.stringify(ed.project) === committed && !ed.hasKeyAt(a.id, 'rot') && Math.abs(quat.angle(ed.currentLocal(a.id).rot, rotY(45))) < 1e-6);
  check('cancel keeps the playhead', Math.abs(ed.time - 0.5) < 1e-9);
  check('cancel leaves no undo entry', ed.history.undoStack.length === 0);
  // override variant (Auto Key off)
  ed.project.settings.autoKey = false;
  ed.setNodeLocal(a.id, { rot: rotY(5) });
  ed.beginInteraction('gizmo-rotate', { cancel: () => ed.restoreCommitted() });
  ed.setNodeLocal(a.id, { rot: rotY(80) }, { commit: false });
  ed.cancelInteraction();
  check('cancel restores the pre-drag unkeyed pose', near(ed.currentLocal(a.id).rot, rotY(5)));
}

// ---------- 7. rotate A → select B → rotate B; frame 0 → scrub 30 → rotate ----------
{
  const { ed, a, b, clip } = makeScene();
  ed.project.settings.autoKey = true;
  ed.select(a.id);
  ed.beginInteraction('gizmo-rotate', { finish: () => ed.commit('rotate') });
  ed.setNodeLocal(a.id, { rot: rotY(33) }, { commit: false });
  ed.select(b.id); // pointer never released "properly"
  check('A committed when B was selected', ed.interactionKind === 'idle' && ed.history.undoStack.length === 1 && near(track(clip, a.id).rot[0].v, rotY(33)));
  ed.beginInteraction('gizmo-rotate', { finish: () => ed.commit('rotate') });
  ed.setNodeLocal(b.id, { rot: rotY(12) }, { commit: false });
  ed.finishInteraction();
  check('B rotates normally afterwards', near(track(clip, b.id).rot[0].v, rotY(12)));
  ed.setTime(1);
  ed.setNodeLocal(b.id, { rot: rotY(40) });
  check('rotate at frame 30 uses that frame', near(ed.currentLocal(b.id).rot, rotY(40)) && track(clip, b.id).rot.length === 2);
  ed.setTime(0);
  check('frame 0 still holds its own value', near(ed.currentLocal(b.id).rot, rotY(12)));
}

// ---------- 8. constraint-driven bones are reported ----------
{
  const { ed, a, b, c } = makeScene();
  ed.select(c.id);
  ed.addConstraint(c.id);
  const k = ed.project.constraints[0];
  check('chain bones are reported as IK-driven', !!ed.constraintDriving(c.id) && !!ed.constraintDriving(b.id) && !ed.constraintDriving(a.id));
  ed.updateConstraint(k.id, { enabled: false });
  check('FK mode makes them editable again', !ed.constraintDriving(c.id) && !ed.constraintDriving(b.id));
  ed.updateConstraint(k.id, { enabled: true, influence: 0 });
  check('zero influence counts as FK', !ed.constraintDriving(c.id));
}

// ---------- 9. loading another project drops all session state ----------
{
  const { ed, a } = makeScene();
  ed.setTime(0.5); ed.setNodeLocal(a.id, { rot: rotY(9) });
  ed.beginInteraction('gizmo-rotate');
  ed.newProject();
  check('new project resets interaction and overrides', ed.interactionKind === 'idle' && ed.poseOverrides.size === 0 && !ed._reorient);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
