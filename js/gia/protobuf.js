// Minimal, lossless protobuf wire-format walker and writer.
//
// A message is represented as a flat array of fields { f, w, v }:
//   w = 0  varint          v: Number (or BigInt when > 2^53)
//   w = 1  64-bit          v: Uint8Array(8)  (kept raw)
//   w = 2  length-delim    v: Uint8Array     (raw bytes; nested messages are
//                                             parsed on demand and re-encoded)
//   w = 5  32-bit          v: Uint8Array(4)  (use f32()/u32() helpers)
// Because every value is kept as raw bytes until explicitly interpreted,
// `encode(parse(bytes))` reproduces `bytes` exactly, and any field we do not
// understand passes through untouched. All editing helpers below re-encode
// only the message they modify.

export function readVarint(buf, o) {
  let v = 0n, s = 0n, x;
  do {
    x = buf[o++];
    v += BigInt(x & 127) << s;
    s += 7n;
  } while (x & 128);
  return [v, o];
}

const toNum = (v) => (v <= 0x1fffffffffffffn ? Number(v) : v);

export function parse(buf, start = 0, end = buf.length) {
  const out = [];
  let o = start;
  while (o < end) {
    let key;
    [key, o] = readVarint(buf, o);
    const f = Number(key >> 3n), w = Number(key & 7n);
    if (w === 2) {
      let len;
      [len, o] = readVarint(buf, o);
      len = Number(len);
      if (o + len > end) throw new Error(`protobuf: length overrun at ${o}`);
      out.push({ f, w, v: buf.subarray(o, o + len) });
      o += len;
    } else if (w === 0) {
      let v;
      [v, o] = readVarint(buf, o);
      out.push({ f, w, v: toNum(v) });
    } else if (w === 5) {
      out.push({ f, w, v: buf.subarray(o, o + 4) });
      o += 4;
    } else if (w === 1) {
      out.push({ f, w, v: buf.subarray(o, o + 8) });
      o += 8;
    } else {
      throw new Error(`protobuf: unexpected wire type ${w} at ${o}`);
    }
  }
  return out;
}

export function tryParse(bytes) {
  try { return parse(bytes); } catch { return null; }
}

function varintBytes(v) {
  let n = typeof v === 'bigint' ? v : BigInt(Math.round(v));
  if (n < 0n) n += 1n << 64n; // two's complement for negative ints
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}

export function encode(fields) {
  const parts = [];
  let len = 0;
  const push = (arr) => { parts.push(arr); len += arr.length; };
  for (const fl of fields) {
    push(varintBytes((BigInt(fl.f) << 3n) | BigInt(fl.w)));
    if (fl.w === 0) push(varintBytes(fl.v));
    else if (fl.w === 2) { push(varintBytes(fl.v.length)); push(fl.v); }
    else push(fl.v);
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- value helpers ----------
const te = new TextEncoder();
const td = new TextDecoder();

export const f32 = (fl) => new DataView(fl.v.buffer, fl.v.byteOffset, 4).getFloat32(0, true);
export const str = (fl) => td.decode(fl.v);

export function fVarint(f, v) { return { f, w: 0, v }; }
export function fF32(f, x) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return { f, w: 5, v: b };
}
export function fBytes(f, bytes) { return { f, w: 2, v: bytes }; }
export function fStr(f, s) { return { f, w: 2, v: te.encode(s) }; }
export function fMsg(f, fields) { return { f, w: 2, v: encode(fields) }; }

// ---------- query helpers ----------
export const first = (fields, f) => fields.find((x) => x.f === f);
export const all = (fields, f) => fields.filter((x) => x.f === f);
export const vnum = (fields, f) => { const x = first(fields, f); return x && x.w === 0 ? x.v : undefined; };
export const vstr = (fields, f) => { const x = first(fields, f); return x && x.w === 2 ? str(x) : undefined; };
export const vf32 = (fields, f) => { const x = first(fields, f); return x && x.w === 5 ? f32(x) : undefined; };
export const sub = (fields, f) => { const x = first(fields, f); return x && x.w === 2 ? parse(x.v) : null; };

// Follow a path of field numbers through nested messages; returns the parsed
// field list at the end of the path, or null.
export function path(fields, ...fs) {
  let cur = fields;
  for (const f of fs) {
    cur = sub(cur, f);
    if (!cur) return null;
  }
  return cur;
}

// vec3 message {1:x 2:y 3:z} with zero components omitted.
export function readVec3(fields, f) {
  const m = sub(fields, f);
  if (!m) return null;
  return { x: vf32(m, 1) ?? 0, y: vf32(m, 2) ?? 0, z: vf32(m, 3) ?? 0 };
}
export function vec3Fields(v, skipZero) {
  const out = [];
  if (!skipZero || v.x !== 0) out.push(fF32(1, v.x));
  if (!skipZero || v.y !== 0) out.push(fF32(2, v.y));
  if (!skipZero || v.z !== 0) out.push(fF32(3, v.z));
  return out;
}

export function packedVarints(values) {
  const parts = [];
  for (const v of values) parts.push(...varintBytes(v));
  return Uint8Array.from(parts);
}
export function readPacked(bytes) {
  const out = [];
  let o = 0;
  while (o < bytes.length) {
    let v;
    [v, o] = readVarint(bytes, o);
    out.push(toNum(v));
  }
  return out;
}

// ---------- in-place editing ----------
// Replace (or insert, keeping field order) a single field value.
export function setField(fields, field) {
  const i = fields.findIndex((x) => x.f === field.f);
  if (i >= 0) fields[i] = field;
  else {
    // insert before the first field with a larger number to keep files tidy
    const j = fields.findIndex((x) => x.f > field.f);
    if (j >= 0) fields.splice(j, 0, field);
    else fields.push(field);
  }
  return fields;
}
export function removeField(fields, f) {
  for (let i = fields.length - 1; i >= 0; i--) if (fields[i].f === f) fields.splice(i, 1);
  return fields;
}
// Edit a nested message in place: fn receives the parsed sub-fields and may
// mutate them; the message is re-encoded into its parent.
export function editMsg(fields, f, fn) {
  const fl = first(fields, f);
  if (!fl) throw new Error(`protobuf: field ${f} not present`);
  const inner = parse(fl.v);
  const r = fn(inner);
  fl.v = encode(r || inner);
  return fields;
}
export function editPath(fields, fs, fn) {
  if (fs.length === 0) { fn(fields); return fields; }
  return editMsg(fields, fs[0], (inner) => { editPath(inner, fs.slice(1), fn); });
}
