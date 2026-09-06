// The one place the editor decides what a project should do next.
//
// Every contextual hint — the viewport empty state and the next-step line under the project
// header — is derived from this function, and only from live project state. There is no stored
// "current hint" string and no progress flag that can outlive the project it described, so
// starting or opening a project cannot leak the previous project's guidance: the next render
// simply re-derives the step from whatever is in the editor now.
export const WORKFLOW_STEPS = ['import', 'rig', 'animate', 'keys', 'export', 'done'];

export function workflowState(editor) {
  const p = editor?.project || { nodes: [], clips: [] };
  const nodes = p.nodes || [];
  const objects = nodes.filter((n) => n.type === 'object').length;
  const bones = nodes.filter((n) => n.type === 'bone').length;
  const clips = (p.clips || []).length;
  const keyed = (p.clips || []).some((c) => Object.values(c.tracks || {}).some((tr) => tr.pos.length || tr.rot.length));
  // "Has a model" means objects the game can animate. Deleting every object puts the project
  // back at step one even when the source .gia bytes are still held for export.
  const hasModel = objects > 0;
  // Per-project: editor.lastReport is cleared by beginProjectSwitch(), so a previous project's
  // export can never mark this one as finished.
  const exported = !!editor?.lastReport;
  const step = !hasModel ? 'import'
    : !clips ? (bones ? 'animate' : 'rig')
    : !keyed ? 'keys'
    : !exported ? 'export'
    : 'done';
  return { step, hasModel, objects, bones, clips, keyed, exported };
}
