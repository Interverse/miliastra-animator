// Placement of floating UI (menus, popovers) in the fixed overlay layer. Pure, unit-tested.
//
//   anchor: { left, top, width, height } (an element's client rect) or { x, y } (a pointer)
//   size:   { w, h } of the popover;  vp: { w, h } of the window;  gap: px between anchor and popover
// Returns { left, top, flipped } in client coordinates. Opens below the anchor (or at the
// pointer) and flips above when there is more room there; always kept inside the window.
export function placePopover(anchor, size, vp, { gap = 4, margin = 8 } = {}) {
  const isPoint = anchor.width == null;
  const ax = isPoint ? anchor.x : anchor.left;
  const top0 = isPoint ? anchor.y : anchor.top + anchor.height + gap;
  const aboveTop = isPoint ? anchor.y - size.h : anchor.top - gap - size.h;
  let top = top0, flipped = false;
  if (top + size.h > vp.h - margin && aboveTop >= margin) { top = aboveTop; flipped = true; }
  let left = ax;
  if (left + size.w > vp.w - margin) left = Math.max(margin, vp.w - margin - size.w);
  if (left < margin) left = margin;
  top = Math.max(margin, Math.min(top, Math.max(margin, vp.h - margin - size.h)));
  return { left: Math.round(left), top: Math.round(top), flipped };
}
