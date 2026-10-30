import { randomUUID } from "node:crypto";

export const uid = (p) => `${p}_${randomUUID().slice(0, 8)}`;

/**
 * A domain agent owns a slice of simulated product state and a set of tools.
 * Tools are plain functions (args, state) => result; errors are thrown.
 */
export class Agent {
  constructor({ key, name, product, description, keywords, tools }) {
    Object.assign(this, { key, name, product, description, keywords });
    this.tools = tools;
    this.state = {};
    this.log = [];
  }
  describe() {
    return { key: this.key, name: this.name, product: this.product, description: this.description,
      tools: Object.entries(this.tools).map(([n, t]) => ({ name: n, description: t.description })) };
  }
  /** Score how well a free-text request matches this agent (keyword + tool-name hits). */
  score(text) {
    const t = text.toLowerCase();
    let s = 0;
    for (const k of this.keywords) if (t.includes(k)) s += 2;
    for (const n of Object.keys(this.tools)) if (t.includes(n.replace(/_/g, " "))) s += 3;
    return s;
  }
  async call(tool, args = {}) {
    const def = this.tools[tool];
    if (!def) throw new Error(`Agent '${this.key}' has no tool '${tool}'. Available: ${Object.keys(this.tools).join(", ")}`);
    const parsed = def.shape ? def.schema.parse(args) : args;
    const result = await def.run(parsed, this.state);
    this.log.push({ tool, at: new Date().toISOString() });
    return result;
  }
  need(coll, id, label = coll) {
    const v = this.state[coll]?.get(id);
    if (!v) throw new Error(`${this.name}: unknown ${label} '${id}'`);
    return v;
  }
}

export const coll = (state, ...names) => names.forEach((n) => (state[n] ??= new Map()));
