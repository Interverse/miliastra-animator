// Basic Motion Device records (device type 4, "Linear Motion Device" with path
// points), mirroring the game-authored sample byte for byte:
//
//   3: {                                  # one record per exported animation
//     1: name
//     501: 1
//     511: { 1:2 13:{} 502:{ 2:<MotionType> 501:{point}… 502:{} } }   # path points
//     512: { 1:4 15:{ 1:{1:1 3:1} 2:{} 3:5501 4:1 6:5600 7:1 } 502:{ 2:1000 502:{} } }
//     513: { 1:2 13:{} 502:{ 2:1000 502:{} 503:1 } }
//   }
//   point = { 2: position (relative, metres) 3: rotation (absolute, degrees)
//             4: duration (seconds) 5: 900 (straight line) 7:{} 8:{} }
//
// MotionType: 1000 one-way, 1001 back-and-forth, 1002 cyclic (loop).
import { fVarint, fF32, fBytes, fStr, fMsg, vec3Fields } from './protobuf.js';
import { EMPTY } from './gia-file.js';

export const MOTION_ONE_WAY = 1000;
export const MOTION_PING_PONG = 1001;
export const MOTION_CYCLIC = 1002;
export const POINT_STRAIGHT = 900;
export const MIN_POINT_DURATION = 0.03;
export const MAX_DEVICES_PER_OBJECT = 5;

export function pointFields(p) {
  return [
    fMsg(2, vec3Fields(p.pos, true)),
    fMsg(3, vec3Fields(p.rot, true)),
    fF32(4, Math.max(MIN_POINT_DURATION, p.duration)),
    fVarint(5, p.pointType ?? POINT_STRAIGHT),
    fBytes(7, EMPTY),
    fBytes(8, EMPTY),
  ];
}

export function motionDeviceFields({ name, motionType = MOTION_ONE_WAY, points }) {
  return [
    fStr(1, name),
    fVarint(501, 1),
    fMsg(511, [
      fVarint(1, 2), fBytes(13, EMPTY),
      fMsg(502, [fVarint(2, motionType), ...points.map((p) => fMsg(501, pointFields(p))), fBytes(502, EMPTY)]),
    ]),
    fMsg(512, [
      fVarint(1, 4),
      fMsg(15, [fMsg(1, [fF32(1, 1), fF32(3, 1)]), fBytes(2, EMPTY), fVarint(3, 5501), fF32(4, 1), fVarint(6, 5600), fF32(7, 1)]),
      fMsg(502, [fVarint(2, MOTION_ONE_WAY), fBytes(502, EMPTY)]),
    ]),
    fMsg(513, [
      fVarint(1, 2), fBytes(13, EMPTY),
      fMsg(502, [fVarint(2, MOTION_ONE_WAY), fBytes(502, EMPTY), fVarint(503, 1)]),
    ]),
  ];
}
