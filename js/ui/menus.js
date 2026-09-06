// Desktop-style top menus (File / Edit / View / Help) built from the command registry.
// Menus carry the common global actions; each feature keeps its canonical home in a workspace.
import { t, onLangChange } from '../i18n/i18n.js';
import { h } from './dom.js';
import { showMenu } from './dialogs.js';
import { buildCommands } from './commands.js';

export function setupMenus(ctx) {
  const bar = document.getElementById('menubar');
  const item = (cmds, id, extra = {}) => { const c = cmds.find((x) => x.id === id); if (!c) return null; return { label: c.label(), key: c.shortcut(), checked: c.checked ? c.checked() : undefined, disabled: c.when ? !c.when() : false, action: () => c.run(), ...extra }; };
  const menus = {
    file: (cmds) => [item(cmds, 'file.new'), item(cmds, 'file.open'), { sep: true }, item(cmds, 'file.save'), item(cmds, 'file.saveAs'), { sep: true }, item(cmds, 'file.importGia'), item(cmds, 'file.importAnim'), item(cmds, 'file.importProject'), { sep: true }, item(cmds, 'file.exportGia'), item(cmds, 'file.exportProject'), { sep: true }, item(cmds, 'file.clearSaved')],
    edit: (cmds) => [item(cmds, 'edit.undo'), item(cmds, 'edit.redo'), { sep: true }, item(cmds, 'edit.copyKeys'), item(cmds, 'edit.pasteKeys'), item(cmds, 'edit.duplicateKeys'), item(cmds, 'edit.delete'), { sep: true }, item(cmds, 'edit.selectAll'), item(cmds, 'edit.deselect'), item(cmds, 'edit.rename'), { sep: true }, item(cmds, 'edit.parent'), item(cmds, 'edit.unparent'), { sep: true }, { head: t('add.menu') }, item(cmds, 'rig.addBone'), item(cmds, 'rig.addBonesForSelected'), item(cmds, 'rig.addTarget'), item(cmds, 'rig.addPole'), item(cmds, 'anim.addPath')],
    view: (cmds) => [...['front', 'back', 'right', 'left', 'top', 'bottom'].map((v) => item(cmds, 'view.' + v)), item(cmds, 'view.projection'), { sep: true }, item(cmds, 'view.frameSelected'), item(cmds, 'view.frameAll'), { sep: true }, item(cmds, 'view.displayEdit'), { sep: true }, { head: t('view.displayHead') }, ...['showGrid', 'showBones', 'showConstraints', 'showProxies', 'showDecorations', 'showAxes', 'showPivots', 'showWaypaths'].map((k) => item(cmds, 'view.' + k)), item(cmds, 'view.perf'), { sep: true }, item(cmds, 'view.validate')],
    help: (cmds) => [item(cmds, 'help.tutorial'), item(cmds, 'help.controls'), item(cmds, 'help.shortcuts'), { sep: true }, item(cmds, 'settings'), { sep: true }, item(cmds, 'help.about')],
  };
  const build = () => {
    bar.innerHTML = '';
    for (const key of Object.keys(menus)) {
      const b = h('button', { class: 'menu-btn', text: t('menu.' + key) });
      b.addEventListener('click', (e) => { const cmds = buildCommands(ctx); showMenu(e.currentTarget, menus[key](cmds).filter(Boolean)); });
      bar.append(b);
    }
  };
  build();
  onLangChange(build);
}
