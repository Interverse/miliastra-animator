// .gia container + entry model.
//
// Everything is kept as raw protobuf field lists; readers interpret known
// paths, patchers re-encode only the messages they touch. Unknown fields,
// unknown entries and unknown components survive a load → edit → save cycle
// byte-for-byte.
//
// Container: 20-byte big-endian header [fileSize-4][1][806][3][payloadLen]
//            + payload + u32 1657 trailer.
// Payload:   AssetBundle { 1: object entries, 2: decoration/graph entries,
//            3: export tag, 5: engine version, … }
import {
  parse, encode, first, all, vnum, vstr, vf32, sub, path,
  fVarint, fF32, fBytes, fStr, fMsg, readVec3, vec3Fields,
  readPacked, setField, removeField, editMsg, editPath,
} from './protobuf.js';

export const CLASS_OBJECT = 1;
export const CLASS_GAME_OBJECT = 3;
export const CLASS_GRAPH = 9;
export const CLASS_DECORATION = 28;
export const HEADER_MAGIC = [1, 806, 3];
export const TRAILER = 1657;
export const EMPTY = new Uint8Array(0);

// ---------- container ----------

export function parseGia(u8) {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (u8.length < 24) throw new Error('gia: file too small');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const header = {
    sizeMinus4: dv.getUint32(0), m1: dv.getUint32(4), m2: dv.getUint32(8), m3: dv.getUint32(12),
    payloadLen: dv.getUint32(16),
  };
  if (20 + header.payloadLen + 4 > u8.length) throw new Error('gia: payload length exceeds file');
  const payload = u8.subarray(20, 20 + header.payloadLen);
  const trailer = dv.getUint32(20 + header.payloadLen);
  const top = parse(payload);
  const doc = { header, trailer, top: [], entries: [] };
  for (const fl of top) {
    if ((fl.f === 1 || fl.f === 2) && fl.w === 2) {
      const entry = makeEntry(fl.f, parse(fl.v));
      doc.entries.push(entry);
      doc.top.push({ entry });
    } else {
      doc.top.push({ raw: fl });
    }
  }
  doc.exportTag = vstr(top, 3) ?? '';
  doc.engineVersion = vstr(top, 5) ?? '';
  return doc;
}

export function serializeGia(doc) {
  const fields = [];
  for (const item of doc.top) {
    if (item.raw) fields.push(item.raw);
    else fields.push(fMsg(item.entry.topField, item.entry.fields));
  }
  const payload = encode(fields);
  const out = new Uint8Array(20 + payload.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, payload.length + 20);
  dv.setUint32(4, HEADER_MAGIC[0]);
  dv.setUint32(8, HEADER_MAGIC[1]);
  dv.setUint32(12, HEADER_MAGIC[2]);
  dv.setUint32(16, payload.length);
  out.set(payload, 20);
  dv.setUint32(20 + payload.length, TRAILER);
  return out;
}

export function isGiaHeaderValid(doc) {
  const h = doc.header;
  return h.m1 === HEADER_MAGIC[0] && h.m2 === HEADER_MAGIC[1] && h.m3 === HEADER_MAGIC[2] && doc.trailer === TRAILER;
}

// ---------- entries ----------

export function makeEntry(topField, fields) {
  const ident = sub(fields, 1) || [];
  const cls = vnum(fields, 5);
  return {
    topField,
    fields,
    cls,
    guid: vnum(ident, 4),
    identDomain: vnum(ident, 2),
    identKind: vnum(ident, 3),
    get name() { return vstr(this.fields, 3) ?? ''; },
    get kind() {
      if (this.cls === CLASS_DECORATION) return 'decoration';
      if (this.cls === CLASS_GRAPH) return 'graph';
      if (this.cls === CLASS_OBJECT || this.cls === CLASS_GAME_OBJECT) return 'object';
      return 'other';
    },
  };
}

export function entryRefs(entry) {
  return all(entry.fields, 2).map((r) => {
    const rf = parse(r.v);
    return { domain: vnum(rf, 2), kind: vnum(rf, 3), guid: vnum(rf, 4) };
  });
}

export function setEntryName(entry, name) {
  setField(entry.fields, fStr(3, name));
}

// Insert an entry into the document after a given entry (or after the last
// entry of the file when `after` is null).
export function insertEntry(doc, entry, after = null) {
  let idx = -1;
  if (after) idx = doc.top.findIndex((it) => it.entry === after);
  if (idx < 0) {
    for (let i = doc.top.length - 1; i >= 0; i--) if (doc.top[i].entry) { idx = i; break; }
  }
  doc.top.splice(idx + 1, 0, { entry });
  doc.entries.push(entry);
}

export function removeEntry(doc, entry) {
  doc.top = doc.top.filter((it) => it.entry !== entry);
  doc.entries = doc.entries.filter((e) => e !== entry);
}

export function lastEntryOfKind(doc, kind) {
  let last = null;
  for (const it of doc.top) if (it.entry && it.entry.kind === kind) last = it.entry;
  return last;
}

// ---------- object layout ----------
// class 1 (generated model): wrapper 11, logic 6, entity 7, devices 8
// class 3 (game object):     wrapper 12, logic 5, entity 6, devices 7

export function objectLayout(entry) {
  const has11 = !!first(entry.fields, 11);
  const has12 = !!first(entry.fields, 12);
  if (has12 && !has11) return { wrapper: 12, logic: 5, entity: 6, device: 7, gameObject: true };
  if (has11) return { wrapper: 11, logic: 6, entity: 7, device: 8, gameObject: false };
  return null;
}

function objectBodyFields(entry) {
  const lay = objectLayout(entry);
  if (!lay) return null;
  return path(entry.fields, lay.wrapper, 1);
}

function componentType(compFl) {
  const cf = parse(compFl.v);
  return { type: vnum(cf, 1), fields: cf };
}

// Component body: usually field type+10, but logic components use an
// arbitrary mapping (13→22, 14→23, 111→93 …), so fall back to the first
// length-delimited field that is not the type tag.
function compBody(cf, type) {
  let b = first(cf, type + 10);
  if (!b || b.w !== 2) b = cf.find((x) => x.w === 2 && x.f !== 1);
  return b && b.w === 2 ? parse(b.v) : null;
}

// Read a motion device record (device type 4 → body field 3).
export function readMotionDevice(devFields) {
  const pathSec = sub(devFields, 511);
  const pathCfg = pathSec ? sub(pathSec, 502) : null;
  const points = [];
  if (pathCfg) {
    for (const p of all(pathCfg, 501)) {
      const pf = parse(p.v);
      points.push({
        pos: readVec3(pf, 2) || { x: 0, y: 0, z: 0 },
        rot: readVec3(pf, 3) || { x: 0, y: 0, z: 0 },
        duration: vf32(pf, 4) ?? 1,
        pointType: vnum(pf, 5) ?? 900,
      });
    }
  }
  return {
    name: vstr(devFields, 1) ?? '',
    motionType: pathCfg ? vnum(pathCfg, 2) ?? 1000 : 1000,
    points,
    raw: devFields,
  };
}

export function readObject(entry) {
  const lay = objectLayout(entry);
  const body = objectBodyFields(entry);
  const o = {
    entry, guid: entry.guid, name: entry.name, cls: entry.cls, layout: lay, refs: entryRefs(entry),
    gameObject: lay?.gameObject ?? false, templateId: null, isStatic: false, children: [],
    transform: null, collision: false, loadOptimization: null, graphBinding: null,
    devices: [], motionDevices: [], customVariables: null,
  };
  if (!lay || !body) return o;
  const tid = first(body, 2);
  o.templateId = tid ? (tid.w === 0 ? tid.v : vnum(parse(tid.v), 1)) : null;
  for (const c of all(body, lay.logic)) {
    const { type, fields } = componentType(c);
    const b = compBody(fields, type);
    if (type === 1 && b) o.isStatic = vnum(b, 2) === 1;
    if (type === 40 && b) {
      const packed = first(b, 501);
      if (packed && packed.w === 2) o.children = readPacked(packed.v);
      else if (packed) o.children = [packed.v];
    }
  }
  for (const c of all(body, lay.entity)) {
    const { type, fields } = componentType(c);
    const b = compBody(fields, type);
    if (type === 1 && b) {
      o.transform = {
        position: readVec3(b, 1) || { x: 0, y: 0, z: 0 },
        rotation: readVec3(b, 2) || { x: 0, y: 0, z: 0 },
        zoom: readVec3(b, 3) || { x: 1, y: 1, z: 1 },
      };
    }
    if (type === 5 && b) o.collision = b.length > 0;
    if (type === 12 && b) o.loadOptimization = vnum(b, 501) === 1 ? 'on' : vnum(b, 1) === 1 ? 'off' : null;
    if (type === 3 && b && b.length) {
      const k = path(b, 1, 1);
      if (k) o.graphBinding = vnum(k, 2);
    }
  }
  for (const c of all(body, lay.device)) {
    const { type, fields } = componentType(c);
    const b = compBody(fields, type);
    o.devices.push({ type, hasBody: !!b });
    if (type === 4 && b) {
      for (const d of all(b, 3)) o.motionDevices.push(readMotionDevice(parse(d.v)));
    }
    if (type === 1 && b && b.length) {
      o.customVariables = all(b, 1).map((r) => {
        const rf = parse(r.v);
        const rec = { name: vstr(rf, 2) ?? '', type: vnum(rf, 3), guidList: null };
        if (rec.type === 7) {
          const payload = path(rf, 4, 17);
          const packed = payload && first(payload, 1);
          if (packed && packed.w === 2) rec.guidList = readPacked(packed.v);
        }
        return rec;
      });
    }
  }
  return o;
}

export function readDecoration(entry) {
  const body = path(entry.fields, 21, 1);
  const d = { entry, guid: entry.guid, name: entry.name, modelId: null, parentGuid: null, transform: null, argb: null };
  if (!body) return d;
  d.modelId = vnum(body, 2) ?? null;
  for (const c of all(body, 4)) {
    const { type, fields } = componentType(c);
    const b = compBody(fields, type);
    if (type === 40 && b) d.parentGuid = vnum(b, 502) ?? null;
  }
  for (const c of all(body, 5)) {
    const { type, fields } = componentType(c);
    const b = compBody(fields, type);
    if (type === 1 && b) {
      d.transform = {
        position: readVec3(b, 1) || { x: 0, y: 0, z: 0 },
        rotation: readVec3(b, 2) || { x: 0, y: 0, z: 0 },
        scale: readVec3(b, 3) || { x: 1, y: 1, z: 1 },
      };
    }
    if (type === 22 && b) d.argb = vnum(b, 3) ?? null;
  }
  return d;
}

export function readGraph(entry) {
  const g = path(entry.fields, 13, 1, 1);
  const header = g ? sub(g, 1) : null;
  return {
    entry, guid: entry.guid, name: entry.name,
    graphName: g ? vstr(g, 2) ?? '' : '',
    headerGuid: header ? vnum(header, 5) : null,
    nodeCount: g ? all(g, 3).length : 0,
  };
}

// ---------- object patchers ----------

function editBody(entry, fn) {
  const lay = objectLayout(entry);
  if (!lay) throw new Error('gia: not an object entry');
  editPath(entry.fields, [lay.wrapper, 1], (body) => fn(body, lay));
}

function findComponent(body, groupField, type) {
  for (const c of all(body, groupField)) {
    const cf = parse(c.v);
    if (vnum(cf, 1) === type) return { fl: c, fields: cf };
  }
  return null;
}

export function setObjectName(entry, name) {
  setEntryName(entry, name);
  editBody(entry, (body, lay) => {
    const c = findComponent(body, lay.logic, 1);
    if (!c) return;
    editMsg(c.fields, 11, (b) => { setField(b, fStr(1, name)); });
    c.fl.v = encode(c.fields);
  });
}

// pos/rot in GAME coordinates (metres / degrees). Zoom is left untouched.
export function setObjectTransform(entry, pos, rot) {
  editBody(entry, (body, lay) => {
    const c = findComponent(body, lay.entity, 1);
    if (!c) return;
    editMsg(c.fields, 11, (b) => {
      setField(b, fMsg(1, vec3Fields(pos, true)));
      setField(b, fMsg(2, vec3Fields(rot, true)));
    });
    c.fl.v = encode(c.fields);
  });
}

// Standard device set carried by every dynamic prefab (order as exported).
export const STANDARD_DEVICE_TYPES = [18, 1, 3, 19, 6, 14];
function effectSlot(label) {
  return [
    fVarint(3, 1), fVarint(4, 1), fBytes(5, EMPTY), fBytes(6, EMPTY), fF32(7, 1), fBytes(8, EMPTY),
    fBytes(10, EMPTY), fVarint(11, 1), fStr(503, label), fVarint(507, 13),
  ];
}
export function standardDeviceFields(type, bodyFields = []) {
  if (type === 18) {
    return [fVarint(1, 18), fVarint(2, 1), fMsg(28, [fMsg(9, effectSlot('Hit Effect')), fMsg(10, effectSlot('Knockdown Effect')), fStr(11, 'GI_RootNode')])];
  }
  return [fVarint(1, type), fVarint(2, 1), fMsg(type + 10, bodyFields)];
}

// Turn a static unit prefab into a dynamic one: drop the static flag from the
// name component and make sure the six standard devices exist.
export function makeDynamic(entry) {
  editBody(entry, (body, lay) => {
    const c = findComponent(body, lay.logic, 1);
    if (c) {
      editMsg(c.fields, 11, (b) => { removeField(b, 2); });
      c.fl.v = encode(c.fields);
    }
    const devs = all(body, lay.device);
    const present = new Set(devs.map((d) => vnum(parse(d.v), 1)));
    const missing = STANDARD_DEVICE_TYPES.filter((t) => !present.has(t));
    if (!missing.length) return;
    let insertAt = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      if (body[i].f === lay.device || body[i].f === lay.entity) { insertAt = i + 1; break; }
    }
    if (insertAt < 0) insertAt = body.length;
    body.splice(insertAt, 0, ...missing.map((t) => fMsg(lay.device, standardDeviceFields(t))));
  });
}

// Replace the object's Basic Motion Device component (device type 4) with the
// given device records (each an encoded field list for the `3:` message).
// An empty list removes the component.
export function setMotionDevices(entry, deviceRecords) {
  editBody(entry, (body, lay) => {
    const devs = all(body, lay.device);
    const existing = devs.find((d) => vnum(parse(d.v), 1) === 4);
    if (!deviceRecords.length) {
      if (existing) body.splice(body.indexOf(existing), 1);
      return;
    }
    const comp = fMsg(lay.device, [
      fVarint(1, 4), fVarint(2, 1),
      fMsg(14, [...deviceRecords.map((r) => fMsg(3, r)), fVarint(505, 1)]),
    ]);
    if (existing) { body[body.indexOf(existing)] = comp; return; }
    // the game appends the motion-device component after the standard devices
    const after = devs[devs.length - 1];
    if (after) body.splice(body.indexOf(after) + 1, 0, comp);
    else {
      let at = body.length;
      for (let i = body.length - 1; i >= 0; i--) if (body[i].f === lay.entity) { at = i + 1; break; }
      body.splice(at, 0, comp);
    }
  });
}

// ---------- collections ----------

export function collectObjects(doc) {
  return doc.entries.filter((e) => e.kind === 'object').map(readObject);
}
export function collectDecorations(doc) {
  return doc.entries.filter((e) => e.kind === 'decoration').map(readDecoration);
}
export function collectGraphs(doc) {
  return doc.entries.filter((e) => e.kind === 'graph').map(readGraph);
}

export function allGuids(doc) {
  const s = new Set();
  for (const e of doc.entries) {
    if (e.guid != null) s.add(e.guid);
    for (const r of entryRefs(e)) if (r.guid != null) s.add(r.guid);
  }
  return s;
}

export function setExportTag(doc, tag) {
  const item = doc.top.find((it) => it.raw && it.raw.f === 3);
  if (item) item.raw = fStr(3, tag);
}

export function encodeEntry(entry) {
  return encode(entry.fields);
}
