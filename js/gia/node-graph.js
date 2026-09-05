// Animation-switching node graph ("Control Animation Parts") and the invisible
// "Animator Controller" object that owns it.
//
// Base graph (byte-exact copy of the reference export):
//   [1] When Entity Is Created ─► [4] For Each guid in Parts ─► [6] Activate Basic
//        Motion Device(entity ← [5] Query Entity by GUID(guid), name = <initial>)
//   [2] Get Custom Variable(Self [3], "Parts") : GUID list
// Switching extension (encodings taken from the verified controller export):
//   [7] When Custom Variable Changes (string) ─► [9] Branch( [8] Equal(name, "ChangeAnim") )
//        Yes ─► [10] For Each guid in Parts ─► [12] Stop and Delete (all) ─► [13] Activate(new value)
import { fVarint, fF32, fBytes, fStr, fMsg, packedVarints } from './protobuf.js';
import { EMPTY, makeEntry } from './gia-file.js';

export const GRAPH_NAME = 'Control Animation Parts';
export const CONTROLLER_NAME = 'Animator Controller';
export const PARTS_VARIABLE = 'Parts';
export const CHANGE_ANIM_VARIABLE = 'ChangeAnim';
export const OBJECT_TEMPLATE_ID = 10005018;

// ---------- node/pin encoders ----------
const typeMsg = (f, id) => fMsg(f, [fVarint(1, 10001), fVarint(2, 20000), fVarint(3, 22000), fVarint(5, id)]);
const pinId = (f, id) => fMsg(f, id[1] ? [fVarint(1, id[0]), fVarint(2, id[1])] : [fVarint(1, id[0])]);
const typeTag = (dt) => fMsg(4, [fVarint(1, 1), fMsg(100, [fVarint(1, dt)])]);

// literal values (VALUE message field lists)
export const vStr = (s) => [fVarint(1, 5), fVarint(2, 1), typeTag(6), fMsg(105, [fStr(1, s)])];
export const vStrUnset = () => [fVarint(1, 5), typeTag(6), fBytes(105, EMPTY)];
export const vBool = (b) => [fVarint(1, 6), fVarint(2, 1), typeTag(4), b ? fMsg(106, [fVarint(1, 1)]) : fBytes(106, EMPTY)];
// typed-default wrappers (class 10000) as written by the game editor
const wrap = (kind, inner) => [fVarint(1, 10000), fVarint(2, 1), fMsg(110, kind != null ? [fVarint(1, kind), fMsg(2, inner)] : [fMsg(2, inner)])];
export const wStrDefault = (kind) => wrap(kind, [fVarint(1, 5), typeTag(6), fBytes(105, EMPTY)]);
export const wStrLiteral = (kind, s) => wrap(kind, [fVarint(1, 5), fVarint(2, 1), typeTag(6), fMsg(105, [fStr(1, s)])]);
export const wListDefault = (kind, dt) => wrap(kind, [fVarint(1, 10002), typeTag(dt), fBytes(109, EMPTY)]);
export const wGuidDefault = (kind) => wrap(kind, [fVarint(1, 1), typeTag(2), fBytes(101, EMPTY)]);

function pin({ id, id2, value, dataType, link }) {
  const f = [pinId(1, id), pinId(2, id2 || id)];
  if (value) f.push(fMsg(3, value));
  if (dataType != null) f.push(fVarint(4, dataType));
  if (link) f.push(fMsg(5, [fVarint(1, link.node), pinId(2, link.pin), pinId(3, link.pin)]));
  return fMsg(4, f);
}

function node({ id, shell, kernel, pins = [], x, y, comment }) {
  const f = [fVarint(1, id), typeMsg(2, shell), typeMsg(3, kernel ?? shell), ...pins.map(pin), fF32(5, x), fF32(6, y)];
  if (comment) f.push(fMsg(7, [fStr(1, comment)]));
  return fMsg(3, f);
}

// ---------- graph ----------
const DT = { ENTITY: 1, GUID: 2, BOOL: 4, STRING: 6, GUID_LIST: 7 };
const N = {
  CREATED: 71, SELF: 73, BY_GUID: 75, GET_VAR: 50, GET_VAR_GUIDLIST: 60, FOR_EACH: 509, FOR_EACH_GUID: 512,
  ACTIVATE: 267, VAR_CHANGED: 36, VAR_CHANGED_STR: 37, BRANCH: 2, EQUAL: 14, STOP_DELETE: 86,
};

export function buildGraphNodes({ initialAnimation, switching = true }) {
  const nodes = [
    node({ id: 1, shell: N.CREATED, x: -505, y: -216, pins: [{ id: [2], link: { node: 4, pin: [1] } }] }),
    node({ id: 2, shell: N.GET_VAR, kernel: N.GET_VAR_GUIDLIST, x: -647, y: -449, pins: [
      { id: [3], dataType: DT.ENTITY, link: { node: 3, pin: [4] } },
      { id: [3, 1], value: vStr(PARTS_VARIABLE), dataType: DT.STRING },
      { id: [4], value: wListDefault(10, DT.GUID_LIST), dataType: DT.GUID_LIST },
    ] }),
    node({ id: 3, shell: N.SELF, x: -853, y: -449 }),
    node({ id: 4, shell: N.FOR_EACH, kernel: N.FOR_EACH_GUID, x: -184, y: -216, pins: [
      { id: [2], link: { node: 6, pin: [1] } },
      { id: [3], value: wListDefault(3, DT.GUID_LIST), dataType: DT.GUID_LIST, link: { node: 2, pin: [4] } },
      { id: [4], value: wGuidDefault(3), dataType: DT.GUID },
    ] }),
    node({ id: 5, shell: N.BY_GUID, x: 319, y: -98, pins: [{ id: [3], dataType: DT.GUID, link: { node: 4, pin: [4] } }] }),
    node({ id: 6, shell: N.ACTIVATE, x: 748, y: -216, pins: [
      { id: [3], dataType: DT.ENTITY, link: { node: 5, pin: [4] } },
      { id: [3, 1], value: vStr(initialAnimation), dataType: DT.STRING },
    ] }),
  ];
  if (!switching) return nodes;
  nodes.push(
    node({ id: 7, shell: N.VAR_CHANGED, kernel: N.VAR_CHANGED_STR, x: -505, y: 420,
      comment: 'Runtime control: Set Custom Variable "ChangeAnim" on this entity to the name of an exported animation to switch every part to it.',
      pins: [
        { id: [2], link: { node: 9, pin: [1] } },
        { id: [4, 3], value: wStrDefault(1), dataType: DT.STRING },
        { id: [4, 4], value: wStrDefault(1), dataType: DT.STRING },
      ] }),
    node({ id: 8, shell: N.EQUAL, x: -505, y: 640, pins: [
      { id: [3], value: wStrDefault(null), dataType: DT.STRING, link: { node: 7, pin: [4, 2] } },
      { id: [3, 1], value: wStrLiteral(null, CHANGE_ANIM_VARIABLE), dataType: DT.STRING },
    ] }),
    node({ id: 9, shell: N.BRANCH, x: -184, y: 420, pins: [
      { id: [2], link: { node: 10, pin: [1] } },
      { id: [3], dataType: DT.BOOL, link: { node: 8, pin: [4] } },
    ] }),
    node({ id: 10, shell: N.FOR_EACH, kernel: N.FOR_EACH_GUID, x: 140, y: 420, pins: [
      { id: [2], link: { node: 12, pin: [1] } },
      { id: [3], value: wListDefault(3, DT.GUID_LIST), dataType: DT.GUID_LIST, link: { node: 2, pin: [4] } },
      { id: [4], value: wGuidDefault(3), dataType: DT.GUID },
    ] }),
    node({ id: 11, shell: N.BY_GUID, x: 500, y: 560, pins: [{ id: [3], dataType: DT.GUID, link: { node: 10, pin: [4] } }] }),
    node({ id: 12, shell: N.STOP_DELETE, x: 800, y: 420, pins: [
      { id: [2], link: { node: 13, pin: [1] } },
      { id: [3], dataType: DT.ENTITY, link: { node: 11, pin: [4] } },
      { id: [3, 1], value: vStrUnset(), dataType: DT.STRING },
      { id: [3, 2], value: vBool(true), dataType: DT.BOOL },
    ] }),
    node({ id: 13, shell: N.ACTIVATE, x: 1200, y: 420, pins: [
      { id: [3], dataType: DT.ENTITY, link: { node: 11, pin: [4] } },
      { id: [3, 1], value: vStr(initialAnimation), dataType: DT.STRING, link: { node: 7, pin: [4, 4] } },
    ] }),
  );
  return nodes;
}

export function buildGraphEntry({ guid, name = GRAPH_NAME, initialAnimation, switching = true }) {
  const fields = [
    fMsg(1, [fVarint(2, 5), fVarint(4, guid)]),
    fStr(3, name),
    fVarint(5, 9),
    fMsg(13, [fMsg(1, [fMsg(1, [
      fMsg(1, [fVarint(1, 10000), fVarint(2, 20000), fVarint(3, 21001), fVarint(5, guid)]),
      fStr(2, name),
      ...buildGraphNodes({ initialAnimation, switching }),
    ])])]),
  ];
  return makeEntry(2, fields);
}

// ---------- controller object (class-3 game object, no decorations) ----------
// logic components (group 5) use an irregular body field number; entity
// components (group 6) use type + 10
const LOGIC_BODY_FIELD = { 1: 11, 13: 22, 14: 23, 38: 48, 40: 50, 111: 93, 61: 65, 62: 66, 19: 28, 20: 29, 52: 62 };
const comp = (group, type, bodyFields) => fMsg(group, [fVarint(1, type), fMsg(group === 5 ? LOGIC_BODY_FIELD[type] : type + 10, bodyFields)]);

function customVariableRecords({ partGuids, changeAnimDefault }) {
  const recs = [
    fMsg(1, [
      fStr(2, PARTS_VARIABLE), fVarint(3, 7),
      fMsg(4, [fVarint(1, 7), fMsg(2, [fVarint(1, 7), fBytes(2, EMPTY)]), fMsg(17, [fBytes(1, packedVarints(partGuids))])]),
      fVarint(5, 1), fMsg(6, [fVarint(1, 7), fBytes(2, EMPTY)]),
    ]),
  ];
  if (changeAnimDefault != null) {
    recs.push(fMsg(1, [
      fStr(2, CHANGE_ANIM_VARIABLE), fVarint(3, 6),
      fMsg(4, [fVarint(1, 6), fMsg(2, [fVarint(1, 6), fBytes(2, EMPTY)]), changeAnimDefault ? fMsg(16, [fStr(1, changeAnimDefault)]) : fBytes(16, EMPTY)]),
      fVarint(5, 1), fMsg(6, [fVarint(1, 6), fBytes(2, EMPTY)]),
    ]));
  }
  return recs;
}

export function buildControllerEntry({ guid, graphGuid, name = CONTROLLER_NAME, partGuids, changeAnimDefault = null }) {
  const effectSlot = (label) => [
    fVarint(3, 1), fVarint(4, 1), fBytes(5, EMPTY), fBytes(6, EMPTY), fF32(7, 1), fBytes(8, EMPTY),
    fBytes(10, EMPTY), fVarint(11, 1), fStr(503, label), fVarint(507, 13),
  ];
  const dev = (type, body) => fMsg(7, [fVarint(1, type), fVarint(2, 1), fMsg(type + 10, body)]);
  const body = [
    fVarint(1, guid),
    fMsg(2, [fVarint(1, OBJECT_TEMPLATE_ID), fVarint(2, 1)]),
    comp(5, 1, [fStr(1, name)]),
    comp(5, 13, [fVarint(4, 4294967295)]),
    comp(5, 14, [fMsg(1, [fStr(3, 'MPActionGroup')])]),
    comp(5, 38, [fF32(1, 1)]),
    comp(5, 40, []),
    comp(5, 111, []), comp(5, 61, []), comp(5, 62, []), comp(5, 19, []), comp(5, 20, []), comp(5, 52, []),
    comp(6, 1, [fBytes(1, EMPTY), fBytes(2, EMPTY), fMsg(3, [fF32(1, 0.1), fF32(2, 0.1), fF32(3, 0.1)]), fVarint(501, 4294967295)]),
    comp(6, 2, []),
    comp(6, 3, [fMsg(1, [fMsg(1, [fVarint(1, 1), fVarint(2, graphGuid), fVarint(501, 20000)])])]),
    comp(6, 4, [fVarint(1, 1)]),
    comp(6, 5, [fVarint(1, 1), fVarint(2, 1)]),
    comp(6, 6, []),
    comp(6, 7, [fF32(1, 1000), fF32(3, 500), fVarint(4, 1), fVarint(5, 1), fMsg(6, [fVarint(2, 10200002)]),
      ...[8, 9, 10, 11, 12, 13, 14, 15].map((f) => fF32(f, 0.1))]),
    comp(6, 8, [fVarint(1, 1), fVarint(501, 1)]),
    comp(6, 11, [fMsg(1, [fStr(1, 'GI_RootNode'), fBytes(2, EMPTY), fBytes(3, EMPTY), fStr(502, 'Center Origin'), fVarint(504, 1), fStr(505, 'RootNode')])]),
    comp(6, 12, [fVarint(501, 1)]),
    comp(6, 16, []), comp(6, 17, []),
    comp(6, 19, [fVarint(1, 1)]),
    comp(6, 20, []),
    comp(6, 22, [fVarint(3, 4294967295), fF32(4, 100), fVarint(5, 16777215), fVarint(6, 6700)]),
    dev(18, [fMsg(9, effectSlot('Hit Effect')), fMsg(10, effectSlot('Knockdown Effect')), fStr(11, 'GI_RootNode')]),
    dev(1, customVariableRecords({ partGuids, changeAnimDefault })),
    dev(3, []), dev(19, []), dev(6, []), dev(14, []),
    fVarint(8, OBJECT_TEMPLATE_ID),
  ];
  const fields = [
    fMsg(1, [fVarint(2, 1), fVarint(3, 2), fVarint(4, guid)]),
    fMsg(2, [fVarint(2, 5), fVarint(4, graphGuid)]),
    fStr(3, name),
    fVarint(5, 3),
    fMsg(12, [fMsg(1, body), fVarint(2, 1402), fVarint(4, OBJECT_TEMPLATE_ID)]),
  ];
  return makeEntry(1, fields);
}
