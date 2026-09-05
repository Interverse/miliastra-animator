// Small dependency-free vector / quaternion / transform helpers used by the
// scene, animation and export layers (so they run in Node for tests and stay
// independent of the renderer). Vectors are [x,y,z]; quaternions [x,y,z,w].
//
// Coordinate conventions
//   display space (editor, right-handed, three.js):  X right, Y up, Z toward viewer
//   game space    (Miliastra, Unity-like, left-handed): X mirrored
//   display ↔ game:  pos (x,y,z) ↔ (-x,y,z);  Euler YXZ (a,b,c) ↔ (a,-b,-c)

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// ---------- vec3 ----------
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  neg: (a) => [-a[0], -a[1], -a[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  eq: (a, b, eps = 1e-6) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps,
  clone: (a) => [a[0], a[1], a[2]],
  mul: (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]],
};

// ---------- quaternion ----------
export const quat = {
  identity: () => [0, 0, 0, 1],
  clone: (q) => [q[0], q[1], q[2], q[3]],
  mul(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  conj: (q) => [-q[0], -q[1], -q[2], q[3]],
  norm(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
  },
  rotate(q, v) {
    // v' = q v q*
    const [qx, qy, qz, qw] = q, [x, y, z] = v;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return [
      ix * qw + iw * -qx + iy * -qz - iz * -qy,
      iy * qw + iw * -qy + iz * -qx - ix * -qz,
      iz * qw + iw * -qz + ix * -qy - iy * -qx,
    ];
  },
  axisAngle(axis, angle) {
    const a = v3.norm(axis), s = Math.sin(angle / 2);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
  },
  // Euler (radians) with intrinsic Y-X-Z order: R = Ry · Rx · Rz (three.js 'YXZ' / Unity)
  fromEulerYXZ(x, y, z) {
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return [
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 - s1 * s2 * c3,
      c1 * c2 * c3 + s1 * s2 * s3,
    ];
  },
  toEulerYXZ(q) {
    const [x, y, z, w] = quat.norm(q);
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const m11 = 1 - (yy + zz), m13 = xz + wy;
    const m21 = xy + wz, m22 = 1 - (xx + zz), m23 = yz - wx;
    const m31 = xz - wy, m33 = 1 - (xx + yy);
    const ex = Math.asin(-Math.max(-1, Math.min(1, m23)));
    let ey, ez;
    if (Math.abs(m23) < 0.9999999) { ey = Math.atan2(m13, m33); ez = Math.atan2(m21, m22); }
    else { ey = Math.atan2(-m31, m11); ez = 0; }
    return [ex, ey, ez];
  },
  fromEulerDeg: (e) => quat.fromEulerYXZ(e[0] * DEG, e[1] * DEG, e[2] * DEG),
  toEulerDeg: (q) => quat.toEulerYXZ(q).map((a) => a * RAD),
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3],
  slerp(a, b, t) {
    let cos = quat.dot(a, b);
    let bb = b;
    if (cos < 0) { cos = -cos; bb = [-b[0], -b[1], -b[2], -b[3]]; }
    if (cos > 0.9995) return quat.norm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
    const th = Math.acos(cos), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
  },
  // angle between two orientations (radians)
  angle(a, b) {
    const d = Math.min(1, Math.abs(quat.dot(quat.norm(a), quat.norm(b))));
    return 2 * Math.acos(d);
  },
  // shortest-arc rotation taking unit vector a onto unit vector b
  fromUnitVectors(a, b) {
    const d = v3.dot(a, b);
    if (d < -0.999999) {
      let ax = v3.cross([1, 0, 0], a);
      if (v3.len(ax) < 1e-6) ax = v3.cross([0, 1, 0], a);
      return quat.axisAngle(ax, Math.PI);
    }
    const c = v3.cross(a, b);
    return quat.norm([c[0], c[1], c[2], 1 + d]);
  },
  eq: (a, b, eps = 1e-6) => quat.angle(a, b) < eps,
};

// ---------- rigid transforms {pos, rot} ----------
export const xf = {
  identity: () => ({ pos: [0, 0, 0], rot: [0, 0, 0, 1] }),
  clone: (t) => ({ pos: v3.clone(t.pos), rot: quat.clone(t.rot) }),
  // parent ∘ local
  compose: (p, l) => ({ pos: v3.add(p.pos, quat.rotate(p.rot, l.pos)), rot: quat.norm(quat.mul(p.rot, l.rot)) }),
  inverse(t) {
    const r = quat.conj(t.rot);
    return { pos: v3.neg(quat.rotate(r, t.pos)), rot: r };
  },
  // local such that parent ∘ local = world
  localOf: (world, parent) => xf.compose(xf.inverse(parent), world),
};

// ---------- display ↔ game ----------
export const gameToDisplayPos = (p) => [-p.x, p.y, p.z];
export const displayToGamePos = (v) => ({ x: -v[0], y: v[1], z: v[2] });
export const gameEulerToDisplayQuat = (e) => quat.fromEulerYXZ(e.x * DEG, -e.y * DEG, -e.z * DEG);
export function displayQuatToGameEuler(q) {
  const [a, b, c] = quat.toEulerYXZ(q);
  return { x: a * RAD, y: -b * RAD, z: -c * RAD };
}
// game-space quaternion (same YXZ algebra applied to game Euler angles)
export const gameEulerToGameQuat = (e) => quat.fromEulerYXZ(e.x * DEG, e.y * DEG, e.z * DEG);
export function gameQuatToGameEuler(q) {
  const [a, b, c] = quat.toEulerYXZ(q);
  return { x: a * RAD, y: b * RAD, z: c * RAD };
}
export const displayQuatToGameQuat = (q) => gameEulerToGameQuat(displayQuatToGameEuler(q));

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
export const normDeg = (a) => { a = a % 360; if (a > 180) a -= 360; if (a <= -180) a += 360; return a; };
