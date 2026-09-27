// Quick tool changes from another device: a gamepad (Gamepad API) or anything
// that types keys (macro pads, foot pedals, presentation clickers, a keyboard).
// Bindings map an input ("key:Ctrl+F13", "pad:3") to an action id:
//   pen:<tool>      the Pencil's tool          touch:<tool>  the finger's tool
//   penhold:<tool>  the Pencil's tool while held, then back
//   pen-swap        the Pencil's previous tool
//   undo, redo, delete, fit, next-slide, prev-slide

export const TOOL_NAMES = {
  select: "Select", pan: "Pan", pen: "Draw", erase: "Erase", bezier: "Bézier", nodes: "Edit points",
  text: "Text", rect: "Rectangle", ellipse: "Ellipse", circle: "Circle", polygon: "Polygon", line: "Line", arrow: "Arrow",
};

const COMMANDS = {
  "pen-swap": "Pencil: previous tool", undo: "Undo", redo: "Redo", delete: "Delete selection",
  fit: "Fit slide", "next-slide": "Next slide", "prev-slide": "Previous slide",
};

export function actionLabel(id) {
  const [kind, tool] = id.split(":");
  if (kind === "pen") return `Pencil: ${TOOL_NAMES[tool] || tool}`;
  if (kind === "touch") return `Finger: ${TOOL_NAMES[tool] || tool}`;
  if (kind === "penhold") return `Pencil: ${TOOL_NAMES[tool] || tool} while held`;
  return COMMANDS[id] || id;
}

/** Every action, grouped for a menu. */
export function actionGroups() {
  const tools = Object.keys(TOOL_NAMES);
  return [
    ["Pencil tool", tools.map((t) => `pen:${t}`).concat("pen-swap")],
    ["Pencil tool while held", ["erase", "select", "pan", "nodes", "pen"].map((t) => `penhold:${t}`)],
    ["Finger tool", tools.map((t) => `touch:${t}`)],
    ["Commands", ["undo", "redo", "delete", "fit", "next-slide", "prev-slide"]],
  ];
}

// Standard gamepad layout (Xbox names; PlayStation: A=Cross, B=Circle, X=Square, Y=Triangle).
const PAD_NAMES = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "Left stick", "Right stick",
  "D-pad up", "D-pad down", "D-pad left", "D-pad right", "Home"];

export const DEFAULT_BINDINGS = {
  "pad:0": "pen:pen", "pad:1": "pen:erase", "pad:2": "pen:select", "pad:3": "pen:nodes",
  "pad:4": "undo", "pad:5": "redo", "pad:6": "penhold:pan", "pad:7": "pen-swap",
  "pad:12": "pen:bezier", "pad:13": "touch:select", "pad:14": "prev-slide", "pad:15": "next-slide",
};

export function inputLabel(input) {
  const [kind, rest] = [input.slice(0, input.indexOf(":")), input.slice(input.indexOf(":") + 1)];
  if (kind === "pad") return `Controller ${PAD_NAMES[+rest] || "button " + rest}`;
  return rest.split("+").map((k) => k.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1")).join("+");
}

function keyCombo(e) {
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, e.code || e.key].join("+");
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

export class Controller {
  /** run(action, phase) with phase "down" or "up"; bindings is a plain
   *  object that is changed in place; save() persists it. */
  constructor({ run, bindings, save, onChange }) {
    this.run = run;
    this.bindings = bindings;
    this.save = save;
    this.onChange = onChange || (() => {});
    this.learning = null;     // {action, done}
    this.heldKeys = new Map(); // code -> action
    this.padState = new Map(); // "index:button" -> pressed
    this.pads = [];
    this.polling = false;
    window.addEventListener("gamepadconnected", () => { this.refreshPads(); this.startPolling(); });
    window.addEventListener("gamepaddisconnected", () => this.refreshPads());
    window.addEventListener("blur", () => this.releaseAll());
  }

  refreshPads() {
    this.pads = [...(navigator.getGamepads?.() || [])].filter(Boolean).map((p) => p.id);
    this.onChange();
  }

  /** Bind the next key or button to an action; done(input) is called with it,
   *  or with null if Escape cancels. */
  learn(action, done) {
    this.learning = { action, done };
    this.startPolling();
  }

  cancelLearning() {
    const l = this.learning;
    this.learning = null;
    l?.done(null);
  }

  bind(input, action) {
    this.bindings[input] = action;
    this.save();
    this.onChange();
  }

  unbind(input) {
    delete this.bindings[input];
    this.save();
    this.onChange();
  }

  /** Handles a keydown; true if it was a binding (or bound one). */
  keydown(e) {
    if (this.learning) {
      if (MODIFIER_CODES.test(e.code)) return true;  // wait for the key itself
      e.preventDefault();
      e.stopPropagation();
      const l = this.learning;
      this.learning = null;
      if (e.key === "Escape") { l.done(null); return true; }
      const input = `key:${keyCombo(e)}`;
      this.bind(input, l.action);
      l.done(input);
      return true;
    }
    const action = this.bindings[`key:${keyCombo(e)}`];
    if (!action) return false;
    e.preventDefault();
    if (e.repeat) return true;
    this.heldKeys.set(e.code, action);
    this.run(action, "down");
    return true;
  }

  keyup(e) {
    const action = this.heldKeys.get(e.code);
    if (!action) return false;
    this.heldKeys.delete(e.code);
    this.run(action, "up");
    return true;
  }

  releaseAll() {
    for (const action of this.heldKeys.values()) this.run(action, "up");
    this.heldKeys.clear();
    for (const [key, pressed] of this.padState) {
      if (pressed) {
        const action = this.bindings[`pad:${key.split(":")[1]}`];
        if (action) this.run(action, "up");
      }
    }
    this.padState.clear();
  }

  startPolling() {
    if (this.polling || !navigator.getGamepads) return;
    this.polling = true;
    const tick = () => {
      const pads = [...navigator.getGamepads()].filter(Boolean);
      if (!pads.length && !this.learning) { this.polling = false; return; }
      for (const pad of pads) {
        pad.buttons.forEach((b, i) => {
          const key = `${pad.index}:${i}`, pressed = b.pressed || b.value > 0.5;
          const was = this.padState.get(key) || false;
          if (pressed === was) return;
          this.padState.set(key, pressed);
          const input = `pad:${i}`;
          if (pressed && this.learning) {
            const l = this.learning;
            this.learning = null;
            this.bind(input, l.action);
            l.done(input);
            return;
          }
          const action = this.bindings[input];
          if (action && !document.hidden) this.run(action, pressed ? "down" : "up");
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
