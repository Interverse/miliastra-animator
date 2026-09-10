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
* **Preserve child world transforms** (toolbar, next to World/Local; the other
  state is *Children follow*, ordinary hierarchical transforms): move and/or
  rotate the selected bone/object while every descendant (child bones,
  grandchildren, attached objects with their decorations) keeps its world
  transform. It is a rest / rig edit for cleaning up after Auto-Rig or manual
  placement: the local delta is applied to the node's base transform and its
  keys in every clip, and the node's actual world change (measured after
  re-evaluation, so IK is respected) is used to recompute the direct children's
  base transforms and keys with rigid transforms (no Euler subtraction, no
  scale/shear: the hierarchy carries no scale). Works with the Move and Rotate
  gizmos, numeric fields, snapping, Local/World axes and multi-selection
  (descendants of a selected ancestor are compensated once); one drag or field
  edit is one undo step, no keyframes are created, and a toast reports rebased
  keys and IK chains that are re-solved. Rotation edits are always exact;
  moving a bone whose rotation is keyed cannot keep descendants fixed at every
  frame (their offset depends on the bone's rotation at each time), so the
  panel warns beforehand and the edit is exact at the current frame only.
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

## Editor organisation: Model → Rig → Animate → Export

The editor is organised as four **workspaces** (tabs in the top bar) that follow the order
of the work; each shows only the panels that step needs, so the viewport keeps its space:

| Workspace | Left rail | Right rail | Purpose |
| --- | --- | --- | --- |
| **Model** | Outliner | Model, Properties | Import the `.gia`, check orientation & scale (Reorient / Scale entire model), scene settings (global offset, FPS), proxies. The timeline is hidden here. |
| **Rig** | Outliner | Rig, Properties | Bones → IK & controls (targets, poles, constraints) → Rig utilities (Preserve child world transforms, Freeze). |
| **Animate** | Animations, Outliner | Properties, Waypaths | Animations list with an *Import animation* subsection (retargeting), timeline, keyframes, root motion, paths. |
| **Export** | Export (checklist), Outliner | Properties | A checklist — model loaded, animations chosen (≤5), initial animation, path points ≤49, object scale ≤50, validation — where every item is clickable and jumps to the thing to fix, then the Export button. |

Above the left rail, outside the scrolling panels, sits the **compact project header**
(`js/ui/project-bar.js`) — the same in all four workspaces, so project-level context never
moves when the workspace changes:

```
My Project                    ⋯
character.gia · Unsaved changes
▸ PROJECT DETAILS
```

- It answers only *which project is open* and *is it saved*. The name truncates with a tooltip
  in narrow rails; the status never wraps or overlaps.
- `⋯` opens the project actions (Save, Save as, Rename, All projects, New project); the same
  actions are in the File menu and the top-bar 📁 button, so no workspace carries large
  permanent project buttons. The top bar shows the save state as an icon only, to avoid saying
  the same thing twice.
- *Project details* is collapsed by default (state remembered) and holds metadata only: source
  file, modified date, object / decoration / animation counts, storage note. No workflow
  controls live inside it.
- Below the header, a single line of beginner guidance names the next step and offers one
  button. It is hidden before a model is imported (the viewport empty state already asks for
  one) and after the first export.

Other organising principles:

- **Context-sensitive Properties.** The panel shows what the selection is: object (transform,
  display model, then *Advanced ▸* correction / object info / diagnostics), bone (transform,
  length, children, IK constraints, *Advanced ▸* diagnostics), IK target / pole target (which
  constraint uses it, jump to the chain bone, IK on/off, world-locked), display part, or a hint
  when nothing is selected. *Advanced ▸* sections are collapsed by default and remember their state.
- **Workflow guide.** One line under the project header names the next action ("Next: add an
  animation" …); empty states in every panel say what to do next. See *Contextual hints* below.
- **Menus.** File / Edit / View / Help in the top bar carry the global actions (new/open/save/import/
  export, undo/redo/keys/selection/parenting + the Add list, camera views/framing/checkable display
  toggles/performance mode/validate viewport, tutorial/controls/shortcuts/settings/about). Menus,
  the palette and the panels are built from one command registry (`js/ui/commands.js`), so every
  surface runs the same editor method and a setting has one canonical state.
- **Command search.** 🔍 or `Ctrl+Shift+P` (Ctrl+K stays Auto Key) opens a palette that searches
  localized command names and keywords; unavailable commands are listed disabled.
- **Settings (⚙, `Ctrl+,`).** Global preferences only — General (language, time display),
  Navigation (reverse pan/orbit, WASD), Viewport (brightness, unknown geometry, performance mode),
  Input & Shortcuts (snap step/angle, rebindable shortcuts). Project settings stay with the project
  (Model workspace, View menu, Export workspace) and are never mixed with global ones.
- **Toolbar** = Select / Move / Rotate / Scale, Local/World + snapping, Frame selected / Frame all /
  View ▾ / Display ▾. Space still cycles Move/Rotate; Shift+A still opens the Add menu.
- **Narrow layouts.** Below 900 px the side rails become drawers (☰ / ☷ buttons in the top bar,
  tap the viewport to close); medium widths shrink the rails and hide the title.
- Everything is localized in all 15 languages (`tools/check-i18n.mjs` enforces key parity) and
  `tools/test-ui-shell.mjs` checks the workspace/panel matrix, shortcut labels and collisions, the
  command registry ↔ menu wiring and the new keys in every locale.

## Interaction and UI plumbing

- **Language changes re-render everything visible.** Panels subscribe with `onLangChange`;
  dialogs built with `makeDialog` accept functions for title, body and button labels and
  rebuild themselves in place — including the Settings dialog the language is changed from —
  without touching selection, playhead, zoom, filter text or history. No translated text is
  stored in editor state; only keys.
- **One layering scale.** `--z-hud / handles / drop / drawer / popover / float / start / tour /
  palette / toast` in `css/style.css`; nothing sets an ad-hoc z-index. Menus (`showMenu`) render
  in the fixed overlay layer on `document.body` and are placed by `placePopover()`
  (`js/ui/popover-place.js`): below their anchor, flipped above near the bottom edge, pulled
  inside at the sides, following scroll; context menus take a pointer position. The pointerdown
  that closes a menu is swallowed so it never starts a drag underneath.
- **Filter field.** The Graph Editor's search input is created once above the rerendered rows
  (shared `input[type="search"]` styling), so typing keeps focus, caret and selection; the
  global shortcut handler ignores editable elements.
- **Drags are transactions.** `editor.beginKeyDrag()` snapshots the selected keys' tracks on
  pointer-down; every pointer move re-applies the TOTAL offset from the drag start onto that
  snapshot (`updateKeyDrag`), so snapping cannot stall, keys passed over reappear, and release
  (`endKeyDrag`) commits once — Escape/cancel restores with no history entry. Both the Dope
  Sheet and the Graph Editor hold pointer capture, cache the canvas rect for the drag, and
  coalesce pointer moves to one update per animation frame. Time-moving interactions
  (`timeline-*`, `graph-*`) are the only ones `setTime` leaves running, so scrubbing never
  terminates itself when the playhead crosses a frame.

## Auto-framing the animation view

Whenever a different animation becomes active — switching in the selector, Add/Duplicate,
Import animation, opening or recovering a project — the Dope Sheet fits every keyframe of that
clip (all channels: bones, objects, IK targets, poles, retargeted tracks, hidden or collapsed
rows included) into the key area, centred, with padding, at a zoom that stays usable: a single
key or a 0.03 s clip gets at least a 0.5 s window, a minutes-long clip is never truncated
(`js/ui/timeline-fit.js`, pure and unit-tested). It is a view operation only: keys, duration,
playhead and playback are untouched. The fit uses the real canvas width; a timeline that is
hidden when the clip changes (Model workspace, collapsed) frames as soon as it has a size.
After that, pan and zoom belong to the user — moving, adding or deleting keys, scrubbing,
playing or selecting never reset them. The ⤢ button, F/Shift+F with the timeline focused, and
the palette's *Frame animation* run the same calculation on demand. The Graph Editor frames
its own view on clip change (or restores the view last saved for that clip) and keeps a
separate pan/zoom afterwards. Tests: `node tools/test-autoframe.mjs`.

## Graph Editor (curve editor)

The animation area has two views of the same keyframes, switched in its header:
**Dope Sheet** (when keys occur) and **Graph Editor** (how values change between them). They
share the active animation, the playhead, the key selection, Auto Key and the transport; the
choice is remembered as an editor preference.

- **One data model.** The graph edits `clip.tracks` through the same editor methods as the
  Dope Sheet (`selectCurvePoints`, `moveCurvePoints`, `setPointValue/Time/Tangent`,
  `setKeyHandles`, `simplifyCurves` in `js/ui/editor.js`). A graph point is one component of a
  key (`nodeId|ch|t|comp`); selecting it selects the key in the Dope Sheet too. Every edit
  re-evaluates the pose, the inspector and the viewport immediately; a continuous drag is one
  undo entry (transient updates while dragging, one `commit` on release, Escape restores).
- **Channels** come from `channelsOf()` in `js/anim/curves.js`: Position X/Y/Z and
  Rotation X/Y/Z for every node with keys — bones, objects, IK targets and pole targets
  (targets/poles are position-only). `CHANNEL_DEFS` is the one place to add future animatable
  properties. The channel list filters, collapses per item, hides, solos, and marks bones whose
  rotation is currently solved by an IK constraint.
- **Interpolation and handles.** `linear`, `step` and `ease` are the existing per-key modes.
  An eased segment is a cubic Hermite whose end slopes come from the keys' handles
  (`key.h = { m: 'auto' | 'flat' | 'aligned' | 'free', in, out }`, slopes in units per second).
  A key without `h` has flat handles — exactly the smoothstep the editor always produced, so old
  projects play back unchanged. *Automatic* smooths through the neighbours without overshoot
  (flat at extrema and at the ends), *Flat* eases in and out, *Aligned* keeps both handles in a
  line, *Free* allows a kink. Handles are unweighted (drag changes the slope), which keeps the
  curve a function of time. Nothing is offered that export cannot bake.
- **Rotation channels are unwrapped.** Curves plot the authored angles (`key.e`): 0 → 720° rises
  through 720 and is two turns; dragging or typing can pass through any number of revolutions.
  Quaternion-only keys (IK, imported) get a continuous Euler chain from the previous key; the
  first value edit writes it into the track (`ensureEulerTrack`). Never shortest-arc.
- **View.** Time on X (frames or seconds, as the timeline), value on Y in metres or degrees;
  Normalize maps each channel to ±1 for comparing units (display only). Wheel zooms both axes
  (Shift: vertical only, Ctrl: horizontal only, Alt: pan), middle/Alt-drag pans, Frame
  selected / all / animation, Reset view. Snapping: frames (default), other keys' times, value
  steps from Settings → Input; Alt bypasses. Keys closer than 0.03 s still merge (`insertKey`).
- **Editing.** Click / Shift / Ctrl / box selection, free drag (Shift locks to the dominant
  axis), numeric Time/Value fields for the active point, right-click menu (insert key at the
  cursor, delete, duplicate, copy/paste, interpolation, handle type, flatten, frame), double-click
  a curve to insert a key at that time. A vertical drag only changes channels of the grabbed
  unit, so metres and degrees never mix; multi-key time drags keep relative timing.
- **Simplify curves** (`simplifyKeys`): tolerance-based key removal that keeps first/last keys,
  stepped keys and interpolation boundaries, pauses, direction changes, and — by working on
  unwrapped angles — the number and direction of turns. Undoable; the dialog previews
  `before → after`.
- **Export** is unchanged: `bakeClip` samples the evaluated pose (Hermite included) and only
  subdivides where motion is not linear, so a straight A→B segment stays one movement; the
  49-point limit and compression apply after.
- **Persistence.** Handles live on the keys (project data). Graph UI state (zoom/pan, hidden
  and solo channels, collapsed groups, active channel, filter) is saved in the project's `ui`
  record; the Dope Sheet/Graph choice is a preference. Nothing changes the `.gia`.
- Tests: `node tools/test-graph.mjs` (Hermite == smoothstep, handle modes, 0→450/720/1080/−720°
  curves, IK target/pole channels driving the rig, drag/undo/redo/copy-paste/numeric edits,
  Auto Key and inspector sync, box selection geometry, simplification incl. turn counts,
  imported clips, save/reopen, baking and the path limit).

## Contextual hints are derived, never remembered

`js/ui/workflow.js` is the only place that decides what a project should do next. It reads the
live project and returns one step:

| Step | Condition | Hint |
| --- | --- | --- |
| `import` | no objects in the project | *Import a .gia file to begin* |
| `rig` | model, no animations, no bones | add bones, or animate the objects directly |
| `animate` | model and bones, no animations | add an animation |
| `keys` | animations without keyframes | move something with Auto Key on |
| `export` | keyframed animation, not exported yet | check the export checklist |
| `done` | exported | nothing; the guidance stops |

Both surfaces read that function and nothing else: the viewport empty state (title, one-line
explanation, an **Import .gia…** button and the drop reminder) and the one-line next step under
the project header. There is no stored `currentHint` string and no progress flag, so a hint can
never describe a project that is no longer open — every render re-derives it. Undo, redo,
deleting the model, adding or removing animations, retargeting, opening, recovering and
importing all emit `change`, which re-renders both.

The one piece of project progress that used to leak is `editor.lastReport` (set by an export).
It is now cleared in `beginProjectSwitch()`, the single path taken by New, Open, Open Recent,
Import .gia, Open project file, Duplicate and Recover, together with the transient status hint.
So a new project starts at *Import a .gia* even if the previous one was exported, and the Export
panel never shows the previous project's report. Global preferences (language, navigation,
viewport, whether the tour was seen) are untouched by all of this.

Tests: `node tools/test-hints.mjs` walks the regression list — launch, New Project, import,
export-ready, export, New Project again, opening another incomplete project, undo/redo, deleting
the model, session recovery, and four rounds of project switching with no leakage.

## Layout

```
index.html            shell (menus, four workspace tabs, two rails + timeline)
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

## Experimental Auto-Rig (currently hidden)

> **Hidden from the UI.** `FEATURES.autoRig` in `js/ui/feature-flags.js` is `false`, so the
> button in the Rig workspace, the command-palette entry and the beginner prompts that
> suggested it are not shown. Nothing else changed: the implementation, the dialog and the
> editor API stay in the build, projects rigged with Auto-Rig are ordinary bone hierarchies
> that keep loading and editing normally, and `node tools/test-autorig.mjs` still covers it.
> Setting the flag to `true` brings every entry point back.

- Rigging panel, *Experimental Auto-Rig*. Auto-Rig analyses the model's parts and creates a suggested skeleton; you can edit the result before animating. It uses world-space bounds of every object's display parts, left/right symmetry pairs, the centre column, dimensions and name hints (names are a bonus, never required), classifies the layout as humanoid / quadruped / bird / segmented with a confidence, and asks you to pick the type when confidence is low.
- The dialog previews the proposed bones in the viewport (green lines) and lists names, parents, assigned objects and per-bone confidence; untick bones to drop them, rename inline, optionally add leg / arm IK chains with pole targets. Objects it cannot assign confidently are listed and left alone. An existing rig is reported and never overwritten.
- Applying is one undo step: bones are created with their Y axis along the detected limb direction and objects are re-parented preserving their world transforms; nothing in the geometry, animation or `.gia` data changes (the export is byte-identical until you animate). Templates live in `js/rig/autorig.js` so more body plans can be added.
- Tests: `node tools/test-autorig.mjs` (Pantalone humanoid, a nameless quadruped, a segment chain, a bird, apply/undo exactness).

## Root Motion moves the whole rig control system

With Root Motion off, the evaluator (`js/anim/evaluate.js`) holds the root
node's horizontal travel at its first key and takes the same displacement away
from every IK target and pole that follows the root — every control that is not
already a child of the root and not marked **World-locked** (a new checkbox on
targets and poles) — through the control's own parent frame and frozen basis.
The pose relative to the character is therefore identical in moving and
in-place playback: a planted foot slides back under the in-place character
exactly as in an in-place cycle, animated controls keep their authored motion
plus/minus the root component, and IK re-solves to the same limb configuration
shifted by the travel. Nothing is rewritten (root, target and pole keys stay),
so On → Off → On restores the moving behaviour exactly. Root rotation is
treated as animation, not root motion, and plays in both modes. Toggling
settles any active drag first, re-evaluates the current frame and rebinds the
gizmo; undo/redo restore the flag and thus the evaluated poses; export bakes
whichever mode is on, once, with no residual travel in IK-controlled objects.
Retargeted clips key their generated IK targets with the travel included, so
they behave the same way. `node tools/test-rootmotion.mjs` (Auto-Rigged
humanoid with foot/hand IK and knee/elbow poles, animated target and pole,
toggles at frame 0 / middle / end, undo/redo, world-locked control, gizmo
safety, export in both modes; root translation + rotation; Auto-Rigged
quadruped; retargeted FBX).

## Preview Mode: previews never cover the viewport

Every workflow whose purpose is to inspect a proposed change now uses a compact
floating panel (`js/ui/float-panel.js`) instead of a centred modal: Auto-Rig,
Import animation / retargeting, Reorient model, Scale entire model, Simplify
path and the export path-compression preview. The panel has no backdrop, floats
at the viewport's top-right corner by default, can be dragged (position kept
for the session), collapsed and closed, always stays inside the window, and is
sized so small windows keep a usable viewport. Camera orbit / pan / zoom,
framing, the timeline (play, scrub, loop) and the rest of the editor stay
usable; Escape closes the panel only while the focus is inside it. The
proposed result is rendered in the normal viewport as temporary, view-only
state: Auto-Rig bones and compressed paths as lines, orientation and scale
through the display offset (`orientPreview`, `scalePreview` — positions scale
about the model pivot, object display, bone lengths and proxy sizes scale in
the viewport), retargeting as a transient clip. Changing an option updates the
viewport immediately and never creates an undo entry; Apply commits one undo
step, Cancel / ✕ restores the committed state exactly (`restoreCommitted` for
the transient clip). The camera is untouched by entering or leaving a preview.
A "Preview mode" chip appears in the panel header and the viewport status line
while a preview is open. New Project / Open / Import close every open preview
panel and clear all preview state, so no temporary bones, paths, highlights or
transforms survive a project switch. Brief confirmations and error messages
(delete, unsupported file, the path-limit warning) remain ordinary modals.
`node tools/test-preview.mjs`.

## Rotation channels stay continuous through 90°

The editor's Euler order is **YXZ** everywhere (inspector, keys, gizmo, imported
conversion, Motion Device export; `fromEulerYXZ` / `toEulerYXZ` in
`js/core/math.js`, game space is the same triple with Y and Z negated). X is
the middle axis, so the canonical decomposition is singular at X = ±90°: past it
the library returns the equivalent triple (180−x, y+180, z+180), which is why a
bone turning about X used to count 89 → 90 → 89 while Y and Z jumped to ±180.
The orientation itself is correct throughout; only the representation changed.
`quat.eulerNear(q, ref)` now considers every equivalent representation (both
Tait-Bryan solutions, whole turns of each angle, and the free Y/Z split exactly
at the singularity) and returns the one closest to the previously authored or
displayed angles. It is used for gizmo and world-space edits (`setNodeLocal`),
for the inspector when a pose comes from quaternion-only data (IK-driven bones,
quaternion keys — the last shown value per node is the reference), for
retargeted tracks (`unwrapRotationTrack` gives every imported rotation key
continuous angles before key reduction, which interpolates those angles), and
for the exported Motion Device rotations, which are written as the
representation nearest the previous point starting from the placement, so a
turn through 90° never serializes as a ±180° jump. Authored values above ±360°
are preserved; Freeze Rotation is the explicit exception and yields canonical
zeros. Sparse quaternion keys more than 180° apart cannot reveal how many turns
happened (a format limitation); dense FBX/BVH/glTF samples can and do.
`window.rotationDiagnostics(nodeId)` prints authored, canonical, alternative
and shown angles plus the source of the displayed value.
`node tools/test-euler.mjs`.

## Scale entire model (and the per-object scale limit of 50)

Rigging → Model orientation & scale → **Scale entire model…** resizes the
complete assembly uniformly about the model pivot (the global offset), as if a
temporary common root had been scaled and removed (`scaleModel` in
`js/ui/editor.js`): every local position of objects, bones, IK targets and
poles, bone lengths, frozen basis offsets, the parent object's own scale
(`zoom`) — decoration transforms inside the object are NOT touched, they stay
exactly as in the file and follow the parent in the game — display root
offsets, proxy sizes,
translation keys (so root motion travels S times as far), waypath points and
speeds. Rotations, rotation keys, timing and constraint weights are untouched,
so IK solves to the same relative pose at the new size and animations look
identical relative to the resized model. The result is the editable model:
nothing remains to be applied again by export, IK or retargeting (a
`modelScale` field is kept for diagnostics only). Presets 0.25× / 0.5× / 1× /
2×, a factor and a percentage input; the dialog shows the model extent and the
largest resulting object scale. The exporter now writes each object's scale to
the `.gia`. Miliastra's maximum object scale is **50** per axis: the dialog
warns before committing (Cancel / Apply anyway, listing object, GUID, value and
axis), validation reports every oversized object as an error with a link that
selects it, and `exportGia` refuses to serialize such a project — nothing is
clamped silently. `node tools/test-scale.mjs` (0.25× … 10× and a decimal
factor on a rigged model with IK, poles, animation, root motion, waypath,
global offset, corrective rotation and output rotation; unrigged model with
display offsets and proxies; the 49.99 / 50 / 50.01 boundaries; warn-before-
commit at 25 × 3; blocked export).

## Model orientation, Root Motion, multi-turn rotations

- **Reorient model** (Rigging → Model orientation, and offered during animation
  import when the imported skeleton faces a different way than the rig). The
  complete assembly — objects with decorations, bones, IK targets and poles,
  constraints, waypaths and every clip — turns as one unit about the model
  pivot (the global offset); nothing moves relative to anything else. Presets
  say which way the model faces now and which way it should (+Z is the
  editor / glTF / FBX forward), quick Y turns and a custom X/Y/Z rotation are
  available, and the viewport previews the result live. The turn is frozen into
  the rest basis (`reorientModel` in `js/ui/editor.js`): root bones absorb it in
  their frozen `basis` so their editable rotation stays as it was (usually 0),
  root objects take it into their placement, root position keys turn with the
  model (root motion follows the new forward), waypaths turn too. Export uses
  the ordinary world transforms, so the correction is applied exactly once.
  The current forward is detected from the rig's thighs/arms
  (`js/anim/orient.js`). `node tools/test-orient.mjs`.
- **Root Motion per clip** (Clips panel, for clips whose root node has
  horizontal travel; retargeted clips set it from the import option): On plays
  and exports the travel; Off holds the root's X/Z at its first key for preview
  and export while vertical motion and all keys stay untouched, so it can be
  turned back on. Stored on the clip (`rootMotion`, `rootNodeId`) and saved with
  the project.
- **Rotations beyond ±360°**: rotation keys carry the authored, unwrapped Euler
  angles (`key.e`; `node.rotE` for base values) next to the quaternion. Between
  two keys that both carry angles the evaluator interpolates the angles, so
  `0 → 720` plays two turns and `0 → -270` turns the long way; quaternion-only
  keys (IK, retargeting, baked data) still slerp. Typed values are kept verbatim
  (450, 1080 …), gizmo and world-space edits unwrap the new orientation next to
  the previous angles so a continuous drag accumulates past 360°, and copy /
  paste / move / duplicate / save / undo preserve the angles. The baker splits
  any segment that turns more than 150° and path compression never merges
  across more than 150° of performed rotation, so exported paths keep every
  revolution and its direction. `node tools/test-rotation.mjs`.

## Freeze Transform, first animation, robust dialogs, orbit default

- **Freeze Transform** (Properties → *Freeze ▾* on a bone: rotation, position, or
  both; *Unfreeze* folds it back). The bone stays exactly where it is and its
  current transform becomes the new rest: the editable values read 0 / identity.
  Implementation: `node.basis = { pos, rot }` with position = basis.pos + local
  pos (parent frame) and rotation = basis.rot ∘ local rot (`localTransform` /
  `editableLocal` in `js/scene/scene.js`); the IK solver, world-space gizmo edits,
  reparenting, retargeting and Preserve Child World Transforms all read and write
  editable values through those helpers. Keys and unkeyed pose edits of the bone
  are rebased with quaternion composition (exact, so the animation is visually
  identical), descendants need no change because the bone's world pose does not
  change, IK re-solves to the same pose, Auto Key never fires, and it is one
  undo step. *Reset* on a frozen bone returns to the frozen rest.
  `node tools/test-freeze.mjs`.
- **Add Animation with zero animations** always works (Clips *New*, the timeline
  empty state and Export *+ Add animation*): the first clip is "Animation 1",
  becomes active with an empty timeline at frame 0 and an export slot, and
  undo returns to the zero-animation state; projects saved without an export
  slot array no longer break creation.
- **Dialogs never close on a drag release**: backdrop closing needs a genuine
  pointerdown + pointerup on the backdrop (`js/ui/backdrop-guard.js`), and is
  blocked while a file drag is in progress or after pointercancel / lost
  capture / blur / tab switch. The Import Animation dialog accepts a dropped
  animation file (it replaces the source); a drag that leaves the window only
  resets the highlight. The window-level file drop handler defers to an open
  dialog.
- **Vertical orbit default** corrected: the direction that used to require
  *Reverse vertical orbit* is now the default and the checkbox reverses it
  (`orbitSigns` in `js/viewport/camera.js`). Navigation preferences are
  versioned (`migrateNavPrefs`, v2): existing users keep their physical orbit
  direction (their flag is inverted under the new meaning), new users get the
  corrected default. Horizontal orbit, pan and zoom are unchanged.
  `node tools/test-editor-misc.mjs`.

## 49-point path limit on export

Miliastra advertises 50 path movement points per Linear Motion Device path,
but its in-game limit check is unreliable at exactly 50, so the editor treats
**49** as the safe maximum: 1–49 final points export normally, 50 or more stop
the export (`MAX_PATH_POINTS` in `js/anim/path-compress.js`). The exporter now works from an *export plan* (`buildExportPlan` in
`js/gia/gia-export.js`): evaluate → bake → output rotation / start snap →
per-slot auto-compression → final point lists per object and animation. The
plan is validated (`pathLimitViolations`) and only then serialized; an
over-limit plan never reaches the file (`exportGia` throws `pathLimit`). The
Export panel shows each animation's final point count against the limit while
it is open. Clicking Export with an over-limit path opens a warning listing
every affected animation / object with its count and the maximum, offering
**Compress automatically** or **Cancel export** (nothing is ever exported
unchanged or silently truncated). Compression (`js/anim/path-compress.js`)
removes points greedily by least error, where the error of dropping a point is
the largest deviation of every original sample it covered from the merged
segment *at the same time*: shape, start/end, turns, height changes, timing,
speed changes, pauses and orientation changes all survive while collinear,
near-duplicate and baked intermediate samples go first; removed durations merge
into the retained segment so the total duration is unchanged. The preview
dialog shows `84 → 43` per path with the largest deviation (the viewport draws
the original path in grey and the compressed one in amber); **Use compressed
path & export** applies it to the export copy only. If a path cannot reach 49
points within 5 cm / 10° the export stops and says so. An optional checkbox
turns on *Auto-compress* for the affected export slots (an undoable project
setting, also available per slot in the Export panel); the editable animation
is never modified. Manual waypaths have **Simplify path…** with a tolerance
slider and a live `41 → 3 points` count (undoable). `node
tools/test-path-limit.mjs` covers 1 / 48 / 49 / 50 / 51 / 120 points, hundreds of baked
points, straight lines, curves, sharp turns, vertical movement with pauses,
variable speed, orientation changes, multiple paths where only some exceed the
limit, successful and unsafe compression, cancel leaving the project untouched,
the persisted auto-compress setting and manual simplification.

## Viewport lifecycle (no ghosting)

The project is the only source of truth for what the 3D viewport shows. Every
rendered node (object, proxy, bone, IK target, pole) is registered under its
state id in an `EntityRegistry` (`js/viewport/scene-model.js`) and reconciled
every frame with the entity list derived from the project: missing state →
dispose, missing visual → create (objects may be deferred for the progressive
build), changed signature → rebuild, otherwise update. Constraint / parent
lines, Auto-Rig previews, waypaths and gizmos are derived from state each frame
and own no registry entries. The Three.js scene has three roots: `env` (lights,
grid, axes: survives projects), `projectRoot` (nodes + waypath visuals:
disposed and replaced wholesale on New / Open / Recent / Import / Recover) and
`overlay` (editor-only visuals). A project switch first cancels the active
interaction, stops playback, drops previews and prunes selection, then emits
`project:teardown` so the viewport disposes the old root before the new state is
shown; undo/redo finish the active interaction, restore the snapshot and prune
selection/display-part/path-point references so the gizmo never stays attached
to a removed object. Per-node materials and instanced buffers are disposed with
their entity; shared primitive geometries live in a cache and are never
disposed. *View ▾ → Validate viewport state* (also `window.validateViewport()`)
reports orphaned or missing render entities, stray scene children and stale
gizmo/selection references; with `localStorage.debugViewport = '1'` the check
runs automatically after undo, redo and project changes.
`node tools/test-viewport-sync.mjs` drives the real editor through undo/redo of
every entity kind, undo after animation at several playhead positions, New
Project, project switching, progressive builds, mid-drag undo and a 40-cycle
stress run against a headless double built on the same registry and validator.

## Responsive transform fields

XYZ rows (`vec3Row` in `js/ui/dom.js`: position, rotation, scale, display
part offsets, correction, global offset, waypath points) are a CSS grid whose
breakpoints follow the sidebar's own width (`@container rail` queries on
`.rail-scroll`): one line at wide widths, label above the three fields with
X/Y/Z letters at the default width, two columns (X Y / Z) below ~270 px of
rail width, one column when narrower still. Inputs never drop below ~64 px,
nothing overlaps or leaves the rail, and rows with extra controls wrap.
Double-clicking a sidebar resize handle restores the default width.

## Animation import and retargeting

- Clips panel, *Import animation*. Supported formats: **.fbx** (binary and ASCII), **.bvh**, **.gltf** (self-contained) / **.glb** / **.vrm** (VRM humanoid bone maps are used automatically), **.dae** (browser only), and Unity **.anim** clips with generic transform curves. Unity *Humanoid* `.anim` clips store muscle-space curves, not bone transforms; they are rejected with an explanation (export them as FBX or glTF). Meshes in the file are ignored. Parsing uses the Three.js loaders on the main thread with yields between stages (the CDN import map cannot be used inside a Web Worker); a 500 KB Mixamo FBX parses in about 40 ms.
- **Mapping**: bone names are normalised (`mixamorig:`, `Bip01`, `DEF-`, `J_Bip_C_` prefixes; `L`/`R`, `Left`/`Right`, `.L`/`_L` conventions) and matched to roles (hips, spine, chest, neck, head, shoulder / upper arm / forearm / hand, thigh / shin / foot / toe per side); hierarchy depth breaks ties. The dialog shows *target ← source* for every rig bone, with Auto-map, Clear, and mapping presets saved per source skeleton (`js/retarget/bone-map.js`). Duplicate or missing major mappings, missing hips, high sampling rates, unit anomalies and NaN samples are flagged.
- **Rest-pose aware transfer** (`js/retarget/retarget.js`): for each mapped bone the animated world rotation delta from the source rest pose is rotated by the minimal correction that takes the source bone's rest direction onto the target bone's rest direction, then applied to the target rest world rotation and converted to local rotations through the target hierarchy. Only rotations travel, so proportions differ freely; an A-pose source drives a T-pose target with no offset at frame 0. Hips translation is root motion: *In place* (vertical only, default), *Keep* (scaled by target height / source height) or *Ignore*; unit scale (cm) is detected.
- Optional IK: FK feet/hands are baked onto existing IK targets. Keys are reduced within a tolerance (0.2°–1.5°, or keep all) and never closer than 0.03 s; stepped motion is kept. Multiple clips can be selected and renamed. Preview builds a temporary clip and plays it; Cancel restores the project, Apply adds the clips (and export slots) as one undo step and records the mapping and options in the project.
- Tests: `node tools/test-retarget.mjs` (Mixamo FBX, a synthetic 60 fps BVH with `L_/R_` names, A-pose → T-pose, root-motion modes, glTF with two clips, partial skeletons, key reduction, Unity muscle rejection, Motion Device export of the imported clip). The Node tests use the `three` dev dependency; the browser uses the CDN import map.

## Auto-Rig base poses

Auto-Rig now builds the rig in a standard pose: humanoids in a **T-pose** (default) or **A-pose**, quadrupeds standing with legs under the body and the head forward, birds with wings spread, segmented creatures straightened; *Keep imported pose* is always available. Bone heads chain from their parents, lengths come from the detected geometry, and each bone's objects are moved rigidly with it (undoable, geometry and `.gia` data untouched), so animation starts from a predictable rest pose.

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
