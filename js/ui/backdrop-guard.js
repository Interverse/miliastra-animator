// Backdrop-to-close for modal dialogs must be a genuine click: the pointer went
// down on the backdrop AND came up on the backdrop, with no drag, file drag or
// interruption (pointercancel, lost capture, window blur, tab hidden) in
// between. A `click` event alone is not enough: browsers dispatch it on the
// common ancestor of the mousedown and mouseup targets, so dragging a slider or
// a mapping row inside the dialog and releasing over the backdrop produces a
// click on the <dialog> element itself, which used to close it.
export class BackdropGuard {
  constructor() { this.armed = false; this.up = false; this.blocked = false; }
  // pointerdown: `onBackdrop` = the event target is the dialog element itself
  pointerDown(onBackdrop) { this.armed = onBackdrop && !this.blocked; this.up = false; }
  pointerUp(onBackdrop) { this.up = this.armed && onBackdrop; }
  // any interruption (drag of a file over the window, pointercancel, lostpointercapture, blur, visibilitychange)
  interrupt() { this.armed = false; this.up = false; }
  // a file drag is in progress: nothing closes until it ends
  dragStart() { this.blocked = true; this.interrupt(); }
  dragEnd() { this.blocked = false; }
  // click: close only when the whole sequence happened on the backdrop
  click(onBackdrop) { const ok = this.armed && this.up && onBackdrop && !this.blocked; this.armed = false; this.up = false; return ok; }
}
