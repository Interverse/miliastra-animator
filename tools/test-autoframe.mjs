// Auto-framing of the Dope Sheet / Graph Editor time view when an animation becomes active.
//   node tools/test-autoframe.mjs
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { activeClip, insertKey, MIN_KEY_SPACING } from '../js/anim/clips.js';
import { keyRange, fitTimeRange, rangeVisible, ZOOM_MIN, ZOOM_MAX, MIN_SPAN } from '../js/ui/timeline-fit.js';
import { quat } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const fx = (p) => readFileSync(new URL('./fixtures/' + p, import.meta.url));
const xOf = (view, t) => (t - view.t0) * view.pxPerSec;
// framed = range fully inside, padded (not on the edge) and roughly centred
const framedOk = (range, view, width) => {
  if (!range) return true;
  const a = xOf(view, range.t0), b = xOf(view, range.t1);
  const centred = Math.abs((a + b) / 2 - width / 2) < 1.5;
  return a >= 12 && b <= width - 12 && centred;
};
const readable = (view) => view.pxPerSec >= ZOOM_MIN && view.pxPerSec <= ZOOM_MAX;

// ---------- pure fitting ----------
for (const width of [180, 400, 900, 2400]) {
  const cases = {
    'two keys from 0': { t0: 0, t1: 2 },
    'many keys later than 0': { t0: 3.5, t1: 9.25 },
    'single key': { t0: 1.2, t1: 1.2 },
    'very short (0.03 s)': { t0: 0, t1: MIN_KEY_SPACING },
    'long (10 minutes)': { t0: 0, t1: 600 },
    'starts negative-ish (0.001)': { t0: 0.001, t1: 0.9 },
  };
  for (const [name, r] of Object.entries(cases)) {
    const v = fitTimeRange(r, width);
    check(`${name} @ ${width}px: whole range visible, padded, centred, zoom sane`, framedOk(r, v, width) && readable(v), `t0=${v.t0.toFixed(3)} pps=${v.pxPerSec.toFixed(1)}`);
  }
  const s = fitTimeRange({ t0: 1.2, t1: 1.2 }, width);
  check(`single key @ ${width}px: at least ${MIN_SPAN}s visible, key centred`, width / s.pxPerSec >= MIN_SPAN - 1e-9 && Math.abs(xOf(s, 1.2) - width / 2) < 1.5);
  const e = fitTimeRange(null, width);
  check(`empty animation @ ${width}px: default window starts just before 0`, e.t0 < 0 && xOf(e, 0) > 8 && xOf(e, 0) < width / 3 && readable(e));
  const long = fitTimeRange({ t0: 0, t1: 600 }, width);
  check(`long @ ${width}px: not truncated (last key visible)`, xOf(long, 600) <= width - 8);
}
check('fitting is deterministic for repeated switches', JSON.stringify(fitTimeRange({ t0: 0, t1: 5 }, 600)) === JSON.stringify(fitTimeRange({ t0: 0, t1: 5 }, 600)));

// ---------- key range covers every channel ----------
{
  const ed = new Editor();
  ed.openProjectFile(readFileSync(new URL('./fixtures/bangboo-hips.animator.json', import.meta.url), 'utf8'));
  const c = activeClip(ed.project);
  const r = keyRange(c);
  const target = ed.project.nodes.find((n) => n.type === 'target');
  const allTimes = Object.values(c.tracks).flatMap((tr) => [...tr.pos, ...tr.rot].map((k) => k.t));
  check('range spans every channel of the user rig (bones, IK targets, retargeted tracks)', r && r.t0 === Math.min(...allTimes) && r.t1 === Math.max(...allTimes) && !!c.tracks[target.id]);
  const rest = ed.project.clips.filter((x) => x.id !== c.id);
  const spans = rest.map((x) => keyRange(x)).map((x) => (x ? x.t1 - x.t0 : 0));
  check('clips of very different durations produce different fits', spans.length >= 2 && Math.max(...spans) / Math.max(1e-6, Math.min(...spans)) > 1.2, spans.map((x) => x.toFixed(2)).join(','));
  for (const x of ed.project.clips) { const v = fitTimeRange(keyRange(x), 500); check(`switching to "${x.name}" frames all of its keys`, framedOk(keyRange(x), v, 500)); }
  // save / reopen keeps the active animation; framing is derived, not stored
  const rec = ed.projectRecord();
  const ed2 = new Editor(); ed2.applyRecord(rec);
  check('save/reopen: same active animation, same frame', activeClip(ed2.project).id === c.id && JSON.stringify(fitTimeRange(keyRange(activeClip(ed2.project)), 500)) === JSON.stringify(fitTimeRange(r, 500)));
  // playhead untouched by framing
  const ph = c.playhead;
  fitTimeRange(r, 500);
  check('framing changes no animation data or playhead', c.playhead === ph && keyRange(c).t1 === r.t1);
}

// ---------- multi-turn rotation, IK-only, imported dense, empty → first key ----------
{
  const ed = new Editor();
  ed.importGia(new Uint8Array(fx('White Square.gia')), 'White Square.gia');
  const o = ed.project.nodes.find((n) => n.type === 'object');
  ed.createClip();
  const c = activeClip(ed.project);
  check('a new (empty) animation has no range and gets the default window', keyRange(c) === null && fitTimeRange(keyRange(c), 600).t0 < 0);
  insertKey(c, o.id, 'rot', 0.4, quat.fromEulerDeg([0, 0, 0]), 'linear', [0, 0, 0]);
  insertKey(c, o.id, 'rot', 2.4, quat.fromEulerDeg([0, 720, 0]), 'linear', [0, 720, 0]);
  const v = fitTimeRange(keyRange(c), 600);
  check('multi-turn rotation clip frames its two keys', framedOk({ t0: 0.4, t1: 2.4 }, v, 600));
  for (let i = 0; i < 300; i++) insertKey(c, o.id, 'pos', i * 0.0333, [i, 0, 0], 'linear');
  const dense = keyRange(c);
  const vd = fitTimeRange(dense, 600);
  check('dense imported-style track (300 keys) fits completely and stays readable', framedOk(dense, vd, 600) && readable(vd), `${dense.count} keys, pps=${vd.pxPerSec.toFixed(1)}`);
}

// ---------- retargeted animation (FBX) ----------
{
  const ed = new Editor();
  ed.openProjectFile(readFileSync(new URL('./fixtures/bangboo-hips.animator.json', import.meta.url), 'utf8'));
  const imported = ed.project.clips.find((x) => /walk|kick|animation/i.test(x.name)) || ed.project.clips[0];
  const r = keyRange(imported);
  check('retargeted clip: range covers its keys at narrow and wide widths', [220, 1600].every((w) => framedOk(r, fitTimeRange(r, w), w)));
}

// ---------- manual navigation is preserved: only a clip change re-frames ----------
{
  const view = fitTimeRange({ t0: 0, t1: 2 }, 600);
  const manual = { t0: view.t0 + 0.7, pxPerSec: view.pxPerSec * 3 };
  check('rangeVisible reports the zoomed-in view as not showing everything (the editor does not auto-fix it)', !rangeVisible({ t0: 0, t1: 2 }, manual, 600) && rangeVisible({ t0: 0, t1: 2 }, view, 600));
}

// ---------- the UI wiring (static) ----------
{
  const tl = readFileSync(new URL('../js/ui/timeline.js', import.meta.url), 'utf8');
  const g = readFileSync(new URL('../js/ui/graph-editor.js', import.meta.url), 'utf8');
  check('Dope Sheet frames only when the active clip changes (maybeAutoFrame compares clip ids)', tl.includes('maybeAutoFrame()') && tl.includes('if (id === this.framedClip) return;') && !tl.includes('frameAnimation()\n    this.draw()') );
  check('key edits / scrubbing / playing / selection never call frameAnimation', !/on\('(keys|time|selection|play)'[^\n]*frameAnimation/.test(tl));
  check('a hidden timeline frames once it gets a size', tl.includes('frameWhenSized'));
  check('the Graph Editor keeps its own view and frames on clip change too', g.includes('maybeAutoFrame()') && g.includes('saved.clipId === id'));
  check('the ⤢ button and F in the timeline run the same framing', tl.includes("this.frameAnimation()") && readFileSync(new URL('../js/main.js', import.meta.url), 'utf8').includes('timeline.frameAll()'));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall auto-frame checks passed');
process.exit(failures ? 1 : 0);
