# Agent Space Protocol TypeScript SDK

The TypeScript SDK of the [Agent Space Protocol](https://github.com/agent-space-protocol/agentspaceprotocol):
both ends of the protocol, a participant that enters any space and a skeleton for writing a space
that keeps the protocol's guarantees for you.

**Status: draft**, like the protocol. Not yet published to npm.

| Import | What it gives |
| --- | --- |
| `@agent-space-protocol/sdk/participant` | Connect, shake hands, enter, observe, subscribe (resuming by sequence number after a disconnect), act with generated IDs, basis and deadlines, receive intermediate states and exactly one final outcome, cancel, fetch the record and the vocabulary |
| `@agent-space-protocol/sdk/space` | The space skeleton, the record stores (memory, SQLite) and the giving side of door handovers |
| `@agent-space-protocol/sdk/transport` | WebSocket, HTTP with server-sent events, standard input and output |
| `@agent-space-protocol/sdk/identity` | Ed25519 keys, proofs of identity, passes through doors |
| `@agent-space-protocol/sdk/types` | Types generated from the specification's `schema.json`, and validation against it |

Node 24 or later. The SQLite record store uses Node's built-in `node:sqlite`.

## A participant

```ts
import { Participant } from "@agent-space-protocol/sdk/participant";
import { generateKey } from "@agent-space-protocol/sdk/identity";

const p = await Participant.connect("ws://127.0.0.1:7777", { key: generateKey() });
await p.join({ role: "member" });
const seen = await p.observe();
p.on("event", (entry) => console.log(entry.seq, entry.type));
await p.subscribe();
const outcome = await p.act({ verb: "test.toggle", object: "lamp:1", basis: seen.seq })
  .onUpdate((u) => console.log(u.type))
  .done;
console.log(outcome.end, outcome.reason?.code, outcome.result);
```

If the connection drops, the participant reconnects, resumes its presence, continues the
subscription from the last sequence number it received and resends every request still waiting;
request IDs are idempotent, so nothing runs twice and every request gets exactly one final answer.

## A space

The skeleton keeps the guarantees: exactly one final outcome for every action (deadlines,
cancels, closing and restarts included), idempotent IDs, `basis` and staleness, `unsupported` for
what is not declared, `malformed` for broken messages with an ID, the record with subscriptions,
resuming and expiry, projection by role, presences kept for a grace period, consent and pausing.
You write how verbs are carried out and what the state looks like.

```ts
import { Space, SqliteStore, Refused } from "@agent-space-protocol/sdk/space";

let on = false;
const space = new Space({
  capabilities: { state: "held", participants: { grace_seconds: 60 } },
  vocabulary: {
    namespaces: { room: { version: "0.1.0" } },
    types: { "room.lamp": { line: "A lamp." } },
    verbs: { "room.toggle": { object: "room.lamp", effect: "change", default: { end: "done" }, stale: "refuse" } },
    events: { "room.switched": { line: "A lamp was switched." } },
  },
  store: new SqliteStore("record.db"),
  handlers: {
    observe: () => ({ structure: { things: [{ id: "lamp:1", type: "room.lamp", on }] } }),
    verbs: {
      "room.toggle": (ctx) => {
        if (ctx.object !== "lamp:1") throw new Refused("room.no_such_lamp", `there is no ${ctx.object}`);
        on = !on;
        ctx.emit("room.switched", { on }, { things: ["lamp:1"] });
        return { result: { on } };
      },
    },
  },
});
await space.listen("ws://127.0.0.1:7777");
```

A law returns for `done`, throws `Refused` (nothing happened), `Failed` (with the effects that
did happen), `Uncertain` (unknown, with what is known) or, when asked to stop through
`ctx.signal`, `Stopped`. Long laws call `ctx.sleep` or `ctx.checkpoint` so that cancels, deadlines,
closing and pauses reach them.

## Development

```sh
pnpm install
pnpm --filter @agent-space-protocol/sdk build
pnpm --filter @agent-space-protocol/sdk test
```

`packages/sdk/schema/schema.json` is a copy of the specification's schema. To update it and the
generated types from a checkout of the specification next to this one:

```sh
cd packages/sdk
node scripts/generate-types.ts --sync ../../../agentspaceprotocol          # update
node scripts/generate-types.ts --sync ../../../agentspaceprotocol --check  # verify, as CI does
```

The conformance tests live in the [inspector](https://github.com/agent-space-protocol/inspector).

## Licence

Apache-2.0.
