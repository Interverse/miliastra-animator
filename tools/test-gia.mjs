// Byte-exact checks of the .gia layer against the reference exports.
//   node tools/test-gia.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGia, serializeGia, collectObjects, setMotionDevices, setExportTag, encodeEntry, readObject } from '../js/gia/gia-file.js';
import { motionDeviceFields, MOTION_CYCLIC } from '../js/gia/motion-device.js';
import { buildControllerEntry, buildGraphEntry } from '../js/gia/node-graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const R = join(here, '..', 'References');
const load = (f) => new Uint8Array(readFileSync(join(R, f)));
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
const eq = (a, b) => firstDiff(a, b) === -1;

const files = ['Bangboo.gia', 'Bangboo With Body Path Movement 2 Points.gia', 'Bangboo With Body Path Movement 2 Points With Master Script.gia'];

// 1. lossless round trip
for (const f of files) {
  const src = load(f);
  const out = serializeGia(parseGia(src));
  check(`round-trip ${f}`, eq(src, out), `${src.length} bytes`);
}

// 2. add the "Example Animation" motion device to Bangboo.gia → 2-point sample
{
  const doc = parseGia(load(files[0]));
  const ref = parseGia(load(files[1]));
  const body = doc.entries.find((e) => e.name === 'Body');
  setMotionDevices(body.entry ? body.entry : body, [motionDeviceFields({
    name: 'Example Animation', motionType: MOTION_CYCLIC,
    points: [
      { pos: { x: 1.1382315158843994, y: 1.1920928955078125e-7, z: 0.7486351728439331 }, rot: { x: 0, y: 0, z: 0 }, duration: 1 },
      { pos: { x: 2.1902246475219727, y: 1.1920928955078125e-7, z: 1.4416965246200562 }, rot: { x: 0, y: 0, z: 35.09479522705078 }, duration: 1 },
    ],
  })]);
  const mine = encodeEntry(body);
  const theirs = encodeEntry(ref.entries.find((e) => e.name === 'Body'));
  const d = firstDiff(mine, theirs);
  check('Body entry with motion device == sample', d === -1, d === -1 ? `${mine.length} bytes` : `first diff at ${d} (${mine.length} vs ${theirs.length})`);
  // reading it back
  const o = readObject(body);
  check('readObject motion device', o.motionDevices.length === 1 && o.motionDevices[0].points.length === 2 && o.motionDevices[0].motionType === MOTION_CYCLIC,
    JSON.stringify(o.motionDevices[0]?.points?.[1]));
}

// 3. controller object + graph vs master-script sample
{
  const ref = parseGia(load(files[2]));
  const ctrlRef = ref.entries.find((e) => e.name === 'Animator Controller');
  const graphRef = ref.entries.find((e) => e.name === 'Control Animation Parts');
  const parts = readObject(ctrlRef).customVariables.find((v) => v.name === 'Parts').guidList;
  check('sample Parts list decoded', parts.length === 10, parts.join(','));
  const ctrl = buildControllerEntry({ guid: 1077936670, graphGuid: 1073741825, partGuids: parts });
  const d1 = firstDiff(encodeEntry(ctrl), encodeEntry(ctrlRef));
  check('controller entry == sample', d1 === -1, d1 === -1 ? '' : `first diff at ${d1}`);
  const graph = buildGraphEntry({ guid: 1073741825, initialAnimation: 'Example Animation', switching: false });
  const d2 = firstDiff(encodeEntry(graph), encodeEntry(graphRef));
  check('graph entry (base) == sample', d2 === -1, d2 === -1 ? '' : `first diff at ${d2} (${encodeEntry(graph).length} vs ${encodeEntry(graphRef).length})`);
  const full = buildGraphEntry({ guid: 1073741825, initialAnimation: 'Example Animation', switching: true });
  check('graph entry (switching) encodes', encodeEntry(full).length > encodeEntry(graph).length, `${encodeEntry(full).length} bytes`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
