# Miliastra Animator

A Blender-inspired, browser-only animation editor for Miliastra `.gia` objects.
Import a `.gia`, rig its objects with bones and IK, keyframe position and
rotation, preview, and export a `.gia` in which every moving object carries
Linear Motion Devices plus an animation-switching node graph. Everything runs
client-side; no backend, no build step.

## Deploy on GitHub Pages

1. Push this folder to a repository (the `.nojekyll` file is included).
2. Settings → Pages → *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`.

Three.js is loaded from the jsDelivr CDN through an import map (`index.html`).
Everything else is static ES modules under `js/`.

Local development: any static server works, e.g. `python -m http.server 8765`
then open `http://localhost:8765/`.

## Tests

```bash
npm test
```

`tools/test-gia.mjs` proves the `.gia` layer against the reference exports in
`References/`: lossless round trips, a byte-exact reconstruction of the
"Body Path Movement 2 Points" motion device, and byte-exact reconstruction of
the "Animator Controller" object and the "Control Animation Parts" graph.
`tools/test-core.mjs` covers import → clips, re-parenting, IK, baking
(segment optimisation) and a full export/re-import cycle.
`tools/check-i18n.mjs` verifies that every locale has every key.

## How the export works

| Editor concept | Exported as |
|---|---|
| Object (imported `.gia` object) | The same entry; name/transform updated, static units converted to dynamic (static flag dropped, standard devices 18/1/3/19/6/14 added) |
| Bones, IK, constraints, proxies, waypaths | Never exported; their effect is baked into object motion |
| Animation clip chosen for export | One *Linear Motion Device* (device type 4) per moving object, named after the export slot |
| Keyframes / IK / parenting over time | Straight path points: **relative** position (metres, from the object's placement), **absolute** rotation (degrees), duration per point (≥ 0.03 s) |
| Clip loop setting | Motion type 1002 (cyclic) or 1000 (one-way) |
| Initial animation | `Activate Basic Motion Device` in the generated graph |
| Runtime switching | `When Custom Variable Changes` handler: set the string variable `ChangeAnim` on the *Animator Controller* to an output name |

Motion is sampled from the preview and simplified: an interval becomes a single
point whenever the sampled position and rotation stay within tolerance of
linear interpolation, so an object travelling straight from A to B at constant
speed exports as one point regardless of how it was authored. Eased or
IK-driven motion is split adaptively at the points of largest deviation.

Unknown protobuf fields, decorations, other devices, graphs unrelated to the
generated controller and any future data pass through byte-for-byte; the
exporter only edits the messages it has to.

### Assumptions taken from the reference files

* Path points are relative to the object's own placement in world axes
  (switchable to object-local axes in *Export → Advanced options*).
* Per-point field `4` is the segment duration in seconds and `5: 900` is a
  straight-line point; these match the two-point sample but were not
  independently confirmed for other values.
* Motion type `1002` (Cyclic Movement) is used for looping clips.

## Viewport interaction

* **Move** uses a translation gizmo; **Rotate** uses axis rings: the rotation
  angle is the pointer's angle around the gizmo centre on screen, applied to
  the transform captured at drag start (no per-frame accumulation), in World
  or Local axes, with optional snapping. One drag is one undo step.
* **Rotation mode** (toolbar, next to World/Local): *Children follow* is
  ordinary hierarchical rotation; *Keep children* reorients the selected
  bone/object while every descendant keeps its world transform. It is a rest /
  rig edit: the delta is post-multiplied onto the node's base rotation and its
  rotation keys in every clip, and its inverse (measured from the node's actual
  world change, so IK is respected) is pre-multiplied onto the direct
  children's base transforms and keys, keeping the authored animation visually
  identical. Works with the gizmo, numeric fields, snapping, Local/World axes;
  one drag or field edit is one undo step, and a toast reports rebased keys.
* **Space** toggles Move / Rotate while the viewport has focus; playback is
  Shift+Space or K (rebindable in the shortcuts dialog). Space in the timeline
  still plays.
* Viewport brightness and middle-mouse pan reversal live in the Display panel
  and are stored as local preferences, never in the `.gia`.
* *Add bones for selected* (Outliner / Rigging / Add menu) creates one bone per
  selected object at its pivot and orientation and attaches the object to it,
  keeping world transforms, as a single undoable step.

## Coordinate conventions

Game space is left-handed (Unity-like). The editor mirrors X for display:
positions `(x, y, z) ↔ (-x, y, z)` and Euler YXZ angles `(a, b, c) ↔ (a, -b, -c)`.
Object zoom (0.1 for generated models) scales that object's decorations only;
children keep their real-world size.

## Localization

All UI strings live in `js/i18n/locales/<code>.js`; English is the fallback.
Language choice is shared with the other Miliastra Toolkit sites through the
`miliastra-lang` localStorage key as described in `References/language-sync.md`.

## Layout

```
index.html            shell (three panes + timeline)
css/style.css         toolkit visual style
js/gia/               protobuf walker, .gia model, motion devices, node graph, import/export
js/scene/             scene graph + proxy geometry catalogue
js/anim/              clips, IK, pose evaluation, baking, waypaths
js/viewport/          three.js viewport, camera, navigation gizmo
js/ui/                editor state, panels, timeline, dialogs, shortcuts, tutorial
js/core/              math, undo history, persistence
js/i18n/              i18n runtime + 15 locales
tools/                Node tests and fixtures
```

## Editable display models

- Every object's display geometry (its decorations, including the generic fallback box used for unknown model IDs) can carry an editor-only **display offset**: position, rotation and per-axis scale relative to the object's pivot. It only changes how the object is drawn; the object transform, keyframes, bones, Motion Devices and the exported `.gia` are untouched (`tools/test-display-model.mjs` checks the export is byte-identical).
- **Edit Display Model** (toolbar button, Properties panel, or `Shift+E`) switches the gizmos to that layer: Move drags the display offset, Rotate turns the display geometry about its own pivot, and a **Scale** tool (`S`, only in this mode) resizes it per axis. The viewport shows a cyan *Editing Display Model · name* banner and cyan outlines while the mode is on; leaving the mode returns Move/Rotate to the object exactly as before.
- The Properties panel's *Display model* section has numeric offset / rotation / scale fields, a uniform scale field, and *Reset display model*, which restores the reference geometry (no offset, no rotation, scale 1; unknown models keep the standard fallback box).
- Edits are undoable (a drag is one step, Escape cancels it), saved in project files and local projects, and never exported.

### Individual display parts

- A display model is a collection of **parts**: the decorations from the `.gia` (defaults from the file, never changed) plus custom cuboid / cylinder / sphere parts you add. Hierarchy: `.gia` object transform → display-model root (root offset) → part. Each part has its own position, rotation and scale relative to the root (`js/scene/display-parts.js`).
- **Space** cycles the transform tools that are valid for what is being edited: objects and bones get Move → Rotate → Move; display-model editing (root or parts, one or many) gets Move → Rotate → Scale → Move. If Scale stops being valid (a bone is selected, or the mode is left) the tool moves on to Move by itself. Cycling never creates history entries, changes the selection or the Local/World setting, and is ignored while typing in an input.
- In Edit Display Model mode, clicking a part in the viewport selects that part (Ctrl/Cmd toggles, Shift adds; in the list Shift selects a range). The owner object stays selected, the banner reads *Editing Display Model · Object › Part*, the selected parts get a strong cyan outline and the rest of the model a weak one. With parts selected, Move / Rotate / Scale act on them only (multi-selection moves together, rotates and scales as a group about the selection centre); with none selected they act on the whole display model as before.
- The **Display parts** list in the Properties panel shows every part with its name, kind and visibility; it supports select, multi-select, rename (double-click), hide/show, add (cuboid, cylinder, sphere), duplicate (as custom parts), delete (custom parts are removed, file parts are hidden), reorder, *Reset part* (file parts back to the `/References` definition, custom parts back to their creation state) and *Reset display model* for everything. The active part has numeric offset / rotation / scale fields.
- All of it is undoable (each operation one step, a drag one step), stored in the project (`node.display`), and never written to the exported `.gia` (`tools/test-display-parts.mjs` checks the export stays byte-identical).

## Output rotation

- A slot's **Output rotation (Y°)** turns the **complete assembled model** around the export pivot for that animation, exactly as if everything sat under one temporary root that was rotated: every piece's world position orbits the pivot and every orientation turns with it, so spacing and shape are preserved. It never rotates pieces in place.
- **Pivot:** the model origin, i.e. the configured global position offset (world origin when the offset is zero).
- **Pipeline:** evaluate the world pose at each baked time (parents, bones, IK, corrections, animation, offset already composed) → rotate that pose about the pivot with quaternions → convert to the Motion Device form (position relative to the object's unrotated frame-0 placement, rotation absolute) → game space. Rotations are composed, never added as Euler angles, and each slot is transformed independently, so exporting one clip at 0°/90°/180°/270° yields four copies of the whole model facing each direction.
- **Rest pose:** the placement written to the file (the pose the engine returns to between plays) is the frame-0 pose turned by the **reference animation's** output rotation, using the same whole-model transform. The reference animation is the one the exported graph plays first: the *Initial animation* slot, which by default is the first slot in export order. That animation therefore starts exactly where the model rests, with no snap. Slots with a different output rotation move every object, so all objects get a device record for them and they begin with a 30 ms snap into their own arrangement.
- Tests: `node tools/test-rest-rotation.mjs` (single slots at 90°, 180°, 45°, 29.38°, multi-slot exports with the reference first and with a non-first initial slot, static and bone-driven pieces, corrective offsets, global offset; checks the placement, spacing, the absence of a snap for the reference animation, every slot's waypoints and a re-import).
- **Preview:** each slot has a *Preview* button in the Export panel; the viewport then shows the exported arrangement for that animation (view-only, editing still changes the true pose).
- Regression test: `node tools/test-output-rotation.mjs` (multi-object model away from the origin with a global offset, bone hierarchy and corrective offsets; slots 0/90/180/270/29.38/45°; checks every waypoint, spacing, orientations, the preview and a re-import).

## Export placement: what the editor shows is what the file gets

- The object transform written to the `.gia` is the pose the viewport shows at **frame 0 of the initial animation** (keys, parents, IK, corrections, global offset all included). Motion Device waypoints are measured from that placement: positions are relative to it, rotations are absolute world rotations. The rig's rest pose is only used as placement when no animation is exported.
- Consequence: a bone whose rest rotation differs from its frame-0 key (the supplied Bangboo project has a Body bone at -29.38° Y with an animation starting at 0°) exports exactly like the editor displays it; the rest rotation never leaks into the file as an extra rotation, and the initial animation starts without a snap point.
- **Transform diagnostics** (Properties panel, collapsed by default) list rig rest, correction, pose at the frame, world, export placement, the game-space placement and the waypoint the exporter would write for the current frame; a warning marks a rest pose that differs from the placement. The same trace is available from the command line: `node tools/trace-export.mjs <project.animator.json> [objectName] [exported.gia]`.
- Regression test: `node tools/test-export-pose.mjs` (part of `npm test`) exports the fixture `tools/fixtures/bangboo.animator.json` and a synthetic 73° mismatch and checks every object's placement, every waypoint, and the re-imported result.

## Viewport brightness

The Display panel's brightness slider shades **display geometry only** (model decorations and proxies): below 1 the base colour is darkened, above 1 a self-illumination term makes shapes easier to read. Background, grid, axes, gizmos, bones, selection outlines and opacity are untouched, and brightness never affects exported data. The preference is remembered locally.

## Large models: rendering performance

- **Instanced rendering.** Every display part that shares a geometry (a known model, a primitive, or the unknown-model fallback box) is drawn by one `InstancedMesh`; outlines reuse the same instance matrices with a wireframe material and selection / part highlighting is done with per-instance colours (`js/viewport/parts-view.js`). The supplied 1,750-decoration `Pantalone.gia` went from 3,503 draw calls and ~70 ms per frame to 33 draw calls and under 1 ms of render time; picking is instance-aware (instance id → part id) with an invisible bounding volume standing in for simplified objects.
- **Dirty-state updates.** Instance matrices are rebuilt only when project data changes (`editor.changeVersion`); time scrubs, playback and view preferences do not rebuild them. Styling (colours, outlines, level of detail) is recomputed only when its key changes; the pick list is rebuilt lazily.
- **Unknown geometry** (Display panel, *Unknown geometry*): *Simplified* (default) draws up to 32 unknown parts of an object as wireframe boxes, larger groups as one point per part inside a bounding outline, and very large groups as clustered points; *Individual boxes* and *Hidden* are available. The `.gia` data is never touched.
- **Level of detail** per object from projected size: full (geometry, transparency, outlines), medium (no outlines), far (points + bounds). Selected objects always render in full. Frustum culling uses per-batch bounding spheres; hidden objects and hidden parts cost nothing.
- **Performance mode** (Display panel; *Automatic* above 800 parts, or forced on/off): coarser LOD, medium detail while playing, rig visualisation hidden while playing unless selected, inspector refreshed at 10 Hz. A green *Performance mode* chip appears in the status bar while it is active.
- **Progressive scene construction**: new objects are built within a 12 ms budget per frame with a *Building scene* hint; import stays responsive.
- Regression test: `node tools/test-parts-plan.mjs` (grouping, unknown representation, LOD, performance mode, pick mapping on the Pantalone fixture).

## Experimental Auto-Rig

- Rigging panel, *Experimental Auto-Rig*. Auto-Rig analyses the model's parts and creates a suggested skeleton; you can edit the result before animating. It uses world-space bounds of every object's display parts, left/right symmetry pairs, the centre column, dimensions and name hints (names are a bonus, never required), classifies the layout as humanoid / quadruped / bird / segmented with a confidence, and asks you to pick the type when confidence is low.
- The dialog previews the proposed bones in the viewport (green lines) and lists names, parents, assigned objects and per-bone confidence; untick bones to drop them, rename inline, optionally add leg / arm IK chains with pole targets. Objects it cannot assign confidently are listed and left alone. An existing rig is reported and never overwritten.
- Applying is one undo step: bones are created with their Y axis along the detected limb direction and objects are re-parented preserving their world transforms; nothing in the geometry, animation or `.gia` data changes (the export is byte-identical until you animate). Templates live in `js/rig/autorig.js` so more body plans can be added.
- Tests: `node tools/test-autorig.mjs` (Pantalone humanoid, a nameless quadruped, a segment chain, a bird, apply/undo exactness).

## IK targets and poles as animation controls

- IK targets and pole targets are first-class rig controls: select them in the viewport, the Outliner, the timeline rows, or with the ⌖ buttons next to *Target* / *Pole* in the Rigging panel, and the Move gizmo binds immediately (Local/World axes and snapping apply). They keep their distinct marker shapes (orange octahedron for targets, yellow icosahedron for poles) with a strong highlight when selected; no text labels are drawn in the viewport.
- The solver only reads their **position**, so no Rotate gizmo, rotation fields or rotation keys are offered for them; Space cycles Move only, and the Rotate button is hidden while one is active. Selecting a bone or object brings Rotate back.
- Moving a target re-solves the chain live; moving a pole steers the bend. With Auto Key on, drags key the position at the current frame; *Key position* / **I** do the same. At an unkeyed frame with Auto Key off the drag is authoritative until committed (see *Timeline vs. edits*). A drag is one undo step.
- Keyed target and pole motion drives the evaluated rig, so the exporter bakes the resulting bone-driven object poses into the Motion Devices; the control objects themselves are never written to the `.gia`.
- Test: `node tools/test-ik-controls.mjs` (tool availability, live re-solve, position-only keys, keys at several frames, drag authority at unkeyed frames, pole bend, undo/redo, export).

## Editing model: interactions, timeline and transforms

- **One interaction at a time.** Every pointer drag (Move/Rotate gizmo, camera orbit/pan/dolly/fly, timeline scrub/key move/box select, panel resize) registers with the editor's interaction state machine (`editor.beginInteraction`). Starting a new one finishes the previous one, and each transition back to idle runs the owner's cleanup exactly once, so a missed browser event can never leave the editor "dragging". Failsafes finish the active interaction on window blur, tab hide, `pointercancel`, lost pointer capture, any late `pointerup`, and when a dialog or menu opens. **Escape** cancels the active transform and restores the drag-start pose.
- **Selection, tool, space and frame changes** (viewport click, Outliner, timeline, Space/Q/W/E, Local/World, arrow keys, scrubbing, undo/redo) first finish an unfinished transform, then rebind the gizmo to the new state. A transform never keeps drag-start values from a previous frame or node.
- **Timeline vs. edits.** With Auto Key on, transforms key the current frame. With Auto Key off, editing an animated channel where no key exists becomes an *unkeyed pose change*: the viewport, inspector and IK see the edited pose (the evaluator never snaps it back), the status bar and Properties panel say so, and **I** / *Insert keyframe* turns it into a key. Changing frame, clip or playback discards it, exactly like Blender. Editing on a keyed frame updates that key; unanimated channels edit the base transform.
- **Playback vs. editing.** Starting a gizmo drag or a numeric edit pauses playback at the current playhead; it never resumes on its own.
- **IK-driven bones.** A bone inside an enabled IK chain shows *Rotation is driven by IK constraint …* with *Select target* and *Switch to FK* buttons instead of silently ignoring rotation. Disabled constraints (FK) leave the bones fully editable.
- Regression tests for these sequences: `node tools/test-interaction.mjs` (part of `npm test`).

## Saving projects locally

- **Ctrl+S / Cmd+S** saves the complete editable project (scene, bones, IK, clips, waypaths, export slots and the original `.gia`) into the browser's IndexedDB. The first save asks for a project name; later saves update the same project. **Ctrl+Shift+S** is *Save as* and creates a separate copy.
- The topbar shows **● Unsaved changes** / **✓ Saved** (also mirrored in the window title with `*`). Clicking the chip saves.
- On launch, when saved projects exist, a **Recent projects** screen lists them (most recently modified first, with the `.gia` file name, date and animation count). From there you can **Open**, **Rename**, **Duplicate** or **Delete** a project, start a **New project**, **Import .gia**, or continue without opening anything. Nothing is opened automatically.
- In the editor the **Projects** menu offers Save, Save as, Open recent, All projects, New, Import and Export project file. The Project panel has the same buttons.
- Switching projects, creating a new one, or importing a `.gia` while there are unsaved changes prompts: **Save and continue**, **Continue without saving**, or **Cancel**.
- Unsaved work is still autosaved to a separate recovery record; if the tab is closed with unsaved changes, the start screen offers **Recover unsaved project** (or Discard). Explicitly saved projects are never touched by recovery.
- Storage quota errors are reported with a message (no silent overwrite); records are versioned (`schema`) and migrated on read.
- **Privacy:** projects are stored only in this browser on this device and are never uploaded anywhere. Clearing site data removes them, so use *Export project file* for backups.
