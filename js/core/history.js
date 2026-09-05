// Snapshot-based undo/redo. The project model is plain JSON, so every
// committed operation stores a serialized copy; undo/redo swaps it back.
export class History {
  constructor(limit = 120) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.current = null;
    this.listeners = new Set();
  }
  reset(state) {
    this.undoStack = [];
    this.redoStack = [];
    this.current = { json: JSON.stringify(state), label: 'init' };
    this.emit();
  }
  commit(state, label = '') {
    const json = JSON.stringify(state);
    if (this.current && json === this.current.json) return false;
    if (this.current) this.undoStack.push(this.current);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.current = { json, label };
    this.redoStack = [];
    this.emit();
    return true;
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() {
    if (!this.canUndo()) return null;
    this.redoStack.push(this.current);
    this.current = this.undoStack.pop();
    this.emit();
    return JSON.parse(this.current.json);
  }
  redo() {
    if (!this.canRedo()) return null;
    this.undoStack.push(this.current);
    this.current = this.redoStack.pop();
    this.emit();
    return JSON.parse(this.current.json);
  }
  undoLabel() { return this.current?.label || ''; }
  redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label || ''; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
}
