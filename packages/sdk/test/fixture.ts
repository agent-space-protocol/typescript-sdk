// A small space for the SDK's own tests: a lamp, a counter, a slow verb and a consent verb.
import { Space, Refused, type SpaceOptions, type Store } from "../src/space/index.ts";
import type { Vocabulary } from "../src/types/index.ts";

export const vocabulary: Vocabulary = {
  namespaces: { t: { version: "0.1.0", line: "A tiny test world." } },
  types: {
    "t.thing": { line: "Anything." },
    "t.lamp": { parent: "t.thing", line: "A lamp.", properties: { type: "object", properties: { on: { type: "boolean" } } } },
    "t.counter": { parent: "t.thing", line: "A counter.", properties: { type: "object", properties: { value: { type: "integer" } } } },
  },
  verbs: {
    "t.toggle": { line: "Toggle a lamp.", object: "t.lamp", effect: "change", default: { end: "done" }, stale: "refuse" },
    "t.add": { line: "Add to a counter.", object: "t.counter", params: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }, effect: "change", default: { end: "done" } },
    "t.wait": { line: "Wait.", params: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] }, effect: "read", default: { end: "done" } },
    "t.launch": { line: "Needs the owner's consent.", effect: "irreversible", default: { end: "done" } },
  },
  events: { "t.toggled": { line: "A lamp was toggled." }, "t.added": { line: "A counter changed." } },
  forms: { text: { media: "text/plain" } },
};

export function makeSpace(options: { store?: Store; keepSeconds?: number | null; grace?: number } = {}) {
  const state = { lamp: false, counter: 0 };
  const opts: SpaceOptions = {
    vocabulary,
    store: options.store,
    keepSeconds: options.keepSeconds,
    capabilities: {
      state: "held",
      participants: {
        grace_seconds: options.grace ?? 30,
        roles: {
          owner: { verbs: ["*"], edit: true, consent: true },
          member: { verbs: ["t.toggle", "t.add", "t.wait", "t.launch"] },
          guest: { verbs: [], hide: { properties: ["value"], events: ["t.added"] } },
        },
        default_role: "member",
      },
      forms: ["text"],
      edit: { roles: ["owner"], changes: ["set"] },
      consent: { verbs: { "t.launch": { by: "owner", seconds: 0.5 } } },
      pause: {},
    },
    handlers: {
      observe: ({ forms }) => ({
        structure: {
          things: [
            { id: "lamp:1", type: "t.lamp", on: state.lamp },
            { id: "counter:1", type: "t.counter", value: state.counter },
          ],
        },
        ...(forms.includes("text") ? { forms: { text: { media: "text/plain", data: `lamp ${state.lamp ? "on" : "off"}, counter ${state.counter}` } } } : {}),
      }),
      verbs: {
        "t.toggle": (ctx) => {
          if (ctx.object !== "lamp:1") throw new Refused("t.no_such_thing", `no lamp ${ctx.object}`);
          state.lamp = !state.lamp;
          ctx.emit("t.toggled", { on: state.lamp }, { things: ["lamp:1"] });
          return { result: { on: state.lamp } };
        },
        "t.add": (ctx) => {
          state.counter += Number(ctx.args.n);
          ctx.emit("t.added", { value: state.counter }, { things: ["counter:1"] });
          return { result: { value: state.counter } };
        },
        "t.wait": async (ctx) => {
          const ms = Number(ctx.args.seconds) * 1000;
          for (let t = 0; t < ms; t += 100) {
            await ctx.sleep(Math.min(100, ms - t));
            ctx.progress(Math.min(1, (t + 100) / ms));
          }
          return { result: { waited: Number(ctx.args.seconds) } };
        },
      },
      edit: (ctx) => {
        for (const c of ctx.changes ?? []) {
          if (c.op === "set" && c.thing === "lamp:1" && c.property === "on") state.lamp = Boolean(c.value);
          else throw new Refused("constraint", "only lamp:1.on can be set", { constraint: "t.fixed" });
        }
        return { things: ["lamp:1"] };
      },
    },
  };
  return { space: new Space(opts), state };
}
