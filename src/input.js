const KEYMAP = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  KeyJ: 'light',
  KeyK: 'heavy',
  KeyL: 'guard',
  KeyO: 'throw',
  Space: 'dash',
  KeyU: 'lance',
  KeyI: 'beam',
  Enter: 'confirm',
  KeyP: 'pause',
  Escape: 'pause',
  KeyM: 'mute',
};

const BUFFER_TIME = 0.2;

/** Keyboard state with a short press buffer so inputs feel responsive during recovery frames. */
export class Input {
  constructor() {
    this.heldKeys = new Map(); // action -> Set(codes) so two keys bound to one action release cleanly
    this.buffer = new Map();
    this.onFirstGesture = null;

    window.addEventListener('keydown', (e) => {
      if (this.onFirstGesture) {
        this.onFirstGesture();
        this.onFirstGesture = null;
      }
      // Leave browser/OS shortcuts alone. While Cmd is down macOS never sends keyup for other
      // keys, so anything recorded here would stay "held" forever: drop what we have instead.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        this.heldKeys.clear();
        return;
      }
      const action = KEYMAP[e.code];
      if (!action) return;
      e.preventDefault();
      // repeats still mark the key as held (it may have been cleared by a blur while down)
      if (!this.heldKeys.has(action)) this.heldKeys.set(action, new Set());
      this.heldKeys.get(action).add(e.code);
      if (!e.repeat) this.buffer.set(action, BUFFER_TIME);
    });
    window.addEventListener('keyup', (e) => {
      const action = KEYMAP[e.code];
      if (action) this.heldKeys.get(action)?.delete(e.code);
    });
    window.addEventListener('blur', () => this.heldKeys.clear());
  }

  held(action) {
    return (this.heldKeys.get(action)?.size ?? 0) > 0;
  }

  /** Consume a buffered press. */
  take(action) {
    if ((this.buffer.get(action) ?? 0) > 0) {
      this.buffer.set(action, 0);
      return true;
    }
    return false;
  }

  /**
   * Consume the first buffered press in priority order and discard the others on the list:
   * keys pressed together are one decision, not a queue.
   */
  takeFirst(actions) {
    let found = null;
    for (const a of actions) {
      if ((this.buffer.get(a) ?? 0) > 0) {
        found ??= a;
        this.buffer.set(a, 0);
      }
    }
    return found;
  }

  endFrame(dt) {
    for (const [k, v] of this.buffer) if (v > 0) this.buffer.set(k, v - dt);
  }
}
