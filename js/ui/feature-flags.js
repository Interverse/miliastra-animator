// Flags for user-facing entry points. Turning one off hides the UI only: the implementation,
// saved project data and file compatibility are untouched, so anything made while the feature
// was visible keeps loading and editing normally.
export const FEATURES = {
  // Experimental Auto-Rig (js/rig/autorig.js, js/ui/autorig-dialog.js,
  // editor.proposeAutoRig / applyAutoRig). Hidden until the skeleton proposal is reliable
  // enough to put in front of beginners. Projects rigged with it are ordinary bone
  // hierarchies and are unaffected; set this to true to show the entry points again.
  autoRig: false,
};
