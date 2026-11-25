import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Participant, OutcomeError } from "../src/participant/index.ts";
import { SqliteStore, Space, handOver, Refused } from "../src/space/index.ts";
import { generateKey, readPass } from "../src/identity.ts";
import { canonicalJson, contentHash, sleep } from "../src/util.ts";
import { makeSpace, vocabulary } from "./fixture.ts";

async function withSpace(fn: (address: string, space: Space) => Promise<void>, opts: Parameters<typeof makeSpace>[0] = {}, scheme = "ws") {
  const { space } = makeSpace(opts);
  const l = await space.listen(`${scheme}://127.0.0.1:0`);
  try {
    await fn(l.address, space);
  } finally {
    await space.close();
  }
}

test("canonical JSON and hashes", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1.5, y: 1e21 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":1e+21,"z":1.5}}');
  assert.match(contentHash(vocabulary), /^sha256:[0-9a-f]{64}$/);
});

for (const scheme of ["ws", "http"]) {
  test(`enter, observe and act over ${scheme}`, async () => {
    await withSpace(
      async (address) => {
        const key = generateKey();
        const p = await Participant.connect(address, { key });
        assert.equal(p.parts.core, 0);
        assert.equal(p.parts.consent, 0);
        const joined = await p.join({ role: "member" });
        assert.equal(joined.role, "member");
        assert.equal(joined.participant, key.identity);
        const obs = await p.observe(["text"]);
        assert.equal(obs.forms?.text.data, "lamp off, counter 0");
        const updates: string[] = [];
        const out = await p.act({ verb: "t.toggle", object: "lamp:1", basis: obs.seq }).onUpdate((u) => updates.push(u.type)).done;
        assert.equal(out.end, "done");
        assert.deepEqual(out.result, { on: true });
        assert.deepEqual(updates, ["accepted"]);
        assert.equal(out.events?.length, 1);
        p.close();
      },
      {},
      scheme,
    );
  });
}

test("standard input and output", async () => {
  const script = join(import.meta.dirname, "stdio-space.ts");
  const p = await Participant.connect(`node "${script}"`, { reconnect: false });
  await p.join();
  const out = await p.act({ verb: "t.add", object: "counter:1", args: { n: 2 } }).done;
  assert.equal(out.end, "done");
  p.close();
});

test("an ID sent three times is carried out once", async () => {
  await withSpace(async (address) => {
    const p = await Participant.connect(address, { key: generateKey() });
    await p.join();
    const answers: unknown[] = [];
    p.on("message", (m) => {
      if (m.type === "outcome" && m.id === "same") answers.push(m);
    });
    for (let i = 0; i < 3; i++) {
      p.send({ type: "act", id: "same", verb: "t.add", object: "counter:1", args: { n: 1 } });
      while (answers.length <= i) await sleep(10);
    }
    assert.equal(answers.length, 3);
    assert.deepEqual(answers[0], answers[1]);
    assert.deepEqual(answers[1], answers[2]);
    const obs = await p.observe();
    assert.equal(obs.structure.things.find((t) => t.id === "counter:1")!.value, 1);
    p.close();
  });
});

test("refusals: forbidden, malformed, unsupported, stale", async () => {
  await withSpace(async (address) => {
    const guest = await Participant.connect(address);
    await guest.join({ role: "guest" });
    assert.equal((await guest.act({ verb: "t.toggle", object: "lamp:1" }).done).reason?.code, "forbidden");
    const obs = await guest.observe();
    assert.equal(obs.structure.things.find((t) => t.id === "counter:1")!.value, undefined, "guest does not see value");
    const p = await Participant.connect(address);
    await p.join();
    assert.equal((await p.act({ verb: "t.add", object: "counter:1", args: { n: "x" } }).done).reason?.code, "malformed");
    assert.equal((await p.act({ verb: "t.nothing" }).done).reason?.code, "unsupported");
    assert.equal((await p.request({ type: "act", verb: 3 }).done).reason?.code, "malformed");
    assert.equal((await p.request({ type: "x.unknown" }).done).reason?.code, "unsupported");
    const before = await p.observe();
    await p.act({ verb: "t.toggle", object: "lamp:1" }).done;
    const stale = await p.act({ verb: "t.toggle", object: "lamp:1", basis: before.seq }).done;
    assert.equal(stale.end, "refused");
    assert.equal(stale.reason?.code, "stale");
    const huge = await p.act({ verb: "t.toggle", object: "lamp:1", basis: 99999 }).done;
    assert.equal(huge.reason?.code, "malformed");
    guest.close();
    p.close();
  });
});

test("cancel, deadline, cancel after done, pause", async () => {
  await withSpace(async (address) => {
    const p = await Participant.connect(address);
    await p.join();
    const slow = p.act({ verb: "t.wait", args: { seconds: 10 } });
    await sleep(150);
    slow.cancel();
    assert.equal((await slow.done).end, "cancelled");
    const late = await p.act({ verb: "t.wait", args: { seconds: 10 }, deadline: 0.3 }).done;
    assert.equal(late.end, "failed");
    assert.equal(late.reason?.code, "deadline");
    const quick = p.act({ verb: "t.toggle", object: "lamp:1" });
    const q = await quick.done;
    let extra = 0;
    p.on("outcome", (o) => o.id === quick.id && extra++);
    quick.cancel();
    await sleep(200);
    assert.equal(q.end, "done");
    assert.equal(extra, 0);
    const paused = p.act({ verb: "t.wait", args: { seconds: 0.4 } });
    await sleep(100);
    assert.equal((await p.request({ type: "pause", action: paused.id }).done).end, "done");
    await sleep(600);
    let finished = false;
    void paused.done.then(() => (finished = true));
    await sleep(50);
    assert.equal(finished, false, "a paused action does not finish");
    await p.request({ type: "resume", action: paused.id }).done;
    assert.equal((await paused.done).end, "done");
    p.close();
  });
});

test("consent: timing out, agreed, refused", async () => {
  await withSpace(async (address) => {
    const p = await Participant.connect(address);
    await p.join();
    const owner = await Participant.connect(address);
    await owner.join({ role: "owner" });
    const waits: any[] = [];
    const timedOut = await p.act({ verb: "t.launch" }).onUpdate((u) => waits.push(u)).done;
    assert.equal(waits[0].type, "waiting");
    assert.equal(timedOut.end, "cancelled");
    assert.equal(timedOut.reason?.code, "deadline");
    const pending = p.act({ verb: "t.launch" }).onUpdate(async (u) => {
      if (u.type === "waiting") {
        assert.equal((await p.request({ type: "consent", act: u.act, agree: true }).done).reason?.code, "forbidden");
        await owner.request({ type: "consent", act: u.act, agree: true }).done;
      }
    });
    assert.equal((await pending.done).end, "done");
    p.close();
    owner.close();
  });
});

test("a dropped connection resumes from its sequence number; an action sent meanwhile gets one outcome", async () => {
  await withSpace(async (address) => {
    const key = generateKey();
    const p = await Participant.connect(address, { key });
    await p.join();
    await p.subscribe();
    const seen: number[] = [];
    p.on("event", (e) => seen.push(e.seq));
    const other = await Participant.connect(address);
    await other.join();
    await other.act({ verb: "t.add", object: "counter:1", args: { n: 1 } }).done;
    await sleep(100);
    const reconnected = new Promise<void>((r) => p.on("reconnect", () => r()));
    p.drop();
    await sleep(50);
    const meanwhile = p.act({ verb: "t.add", object: "counter:1", args: { n: 10 } });
    for (let i = 0; i < 3; i++) await other.act({ verb: "t.add", object: "counter:1", args: { n: 1 } }).done;
    await reconnected;
    const out = await meanwhile.done;
    assert.equal(out.end, "done");
    await sleep(200);
    const record = await p.record({ from: seen[0] });
    const all = record.entries.map((e) => e.seq);
    assert.deepEqual(seen, all, "nothing lost, nothing repeated");
    const outcomes = record.entries.filter((e: any) => e.type === "asp.outcome" && e.data.id === meanwhile.id);
    assert.equal(outcomes.length, 1);
    const obs = await p.observe();
    assert.equal(obs.structure.things.find((t) => t.id === "counter:1")!.value, 14);
    p.close();
    other.close();
  });
});

test("restarted: an action under way when the process was killed is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asp-sdk-"));
  const start = async (port = 0) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "ws-space.ts"), dir, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    const address = await new Promise<string>((resolve) => child.stdout!.once("data", (d) => resolve(String(d).trim())));
    return { child, address };
  };
  try {
    const key = generateKey();
    const first = await start();
    const p = await Participant.connect(first.address, { key, reconnect: false });
    await p.join();
    p.act({ id: "long", verb: "t.wait", args: { seconds: 30 } });
    await sleep(300);
    first.child.kill("SIGKILL");
    await new Promise((r) => first.child.once("exit", r));
    p.close();
    const again = await start();
    const q = await Participant.connect(again.address, { key, reconnect: false });
    await q.join();
    const out = await q.request({ type: "act", id: "long", verb: "t.wait", args: { seconds: 30 } }).done;
    assert.equal(out.end, "unknown");
    assert.equal(out.reason.code, "restarted");
    const record = await q.record({ from: 1 });
    assert.equal(record.entries.filter((e: any) => e.type === "asp.outcome" && e.data.id === "long").length, 1);
    q.close();
    again.child.kill("SIGKILL");
    await new Promise((r) => again.child.once("exit", r));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record expiry", async () => {
  await withSpace(
    async (address) => {
      const p = await Participant.connect(address);
      await p.join();
      await sleep(1500);
      await p.act({ verb: "t.toggle", object: "lamp:1" }).done;
      await assert.rejects(p.record({ from: 1 }), (e: OutcomeError) => e.outcome.reason?.code === "expired");
      await assert.rejects(p.subscribe({ from: 1 }), (e: OutcomeError) => e.outcome.reason?.code === "expired");
      p.close();
    },
    { keepSeconds: 1 },
  );
});

test("closing gives outcomes first, then asp.closing", async () => {
  const { space } = makeSpace();
  const l = await space.listen("ws://127.0.0.1:0");
  const p = await Participant.connect(l.address, { reconnect: false });
  await p.join();
  const order: string[] = [];
  p.on("message", (m) => order.push(m.type === "event" ? m.entry.type : m.type));
  const slow = p.act({ verb: "t.wait", args: { seconds: 30 } });
  await sleep(100);
  await space.close();
  const out = await slow.done;
  assert.equal(out.end, "cancelled");
  assert.equal(out.reason?.code, "closed");
  assert.deepEqual(order.filter((t) => t === "outcome" || t === "asp.closing"), ["outcome", "asp.closing"]);
});

test("doors: a thing is handed over once; a participant gets a pass", async () => {
  const keyA = generateKey();
  const keyB = generateKey();
  const room: string[] = [];
  const b = new Space({
    key: keyB,
    vocabulary: { namespaces: { t: { version: "0.1.0" } }, types: { "t.cup": {} } },
    capabilities: { doors: { takes: true, doors: [{ thing: "door:west", to: "a", space: keyA.identity }] } },
    handlers: {
      observe: () => ({ structure: { things: room.map((id) => ({ id, type: "t.cup" })) } }),
      take: ({ thing }) => {
        room.push(`b-${thing.id}`);
        return { thing: `b-${thing.id}` };
      },
    },
  });
  const lb = await b.listen("ws://127.0.0.1:0");
  let here = true;
  const a = new Space({
    key: keyA,
    vocabulary: { namespaces: { t: { version: "0.1.0" } } },
    capabilities: { doors: { doors: [{ thing: "door:east", to: lb.address, space: keyB.identity }] } },
    handlers: { observe: () => ({ structure: { things: [] } }) },
  });
  const la = await a.listen("ws://127.0.0.1:0");
  const result = await handOver(a, {
    door: "door:east",
    thing: { id: "mug:1", type: "t.mug", parents: ["t.cup"] },
    lock: () => {},
    unlock: () => {},
    remove: () => (here = false),
  });
  assert.equal(result.taken, true);
  assert.equal(here, false);
  assert.deepEqual(room, ["b-mug:1"]);
  if (result.taken) assert.equal(result.result.as, "t.cup");
  const traveller = generateKey();
  const p = await Participant.connect(la.address, { key: traveller });
  await p.join();
  const out = await p.request({ type: "offer", door: "door:east" }).done;
  assert.equal(out.end, "done");
  assert.equal(readPass(out.result.pass, keyA.identity)?.participant, traveller.identity);
  p.close();
  const q = await Participant.connect(lb.address, { key: traveller });
  const joined = await q.join({ pass: out.result.pass });
  assert.ok(joined.presence);
  q.close();
  await a.close();
  await b.close();
});

test("unsupported parts and capabilities", async () => {
  await withSpace(async (address) => {
    const p = await Participant.connect(address, { parts: { core: [0] } });
    await p.join();
    assert.equal((await p.request({ type: "pause", action: "x" }).done).reason?.code, "unsupported");
    assert.equal((await p.request({ type: "snapshot" }).done).reason?.code, "unsupported");
    const errors: any[] = [];
    p.on("message", (m) => m.type === "error" && errors.push(m));
    p.send({ type: "x.unknown" });
    await sleep(100);
    assert.equal(errors[0]?.code, "unsupported");
    p.close();
  });
});

test("an admit handler can refuse", async () => {
  const space = new Space({
    vocabulary,
    capabilities: {},
    handlers: {
      observe: () => ({ structure: { things: [] } }),
      admit: () => {
        throw new Refused("forbidden", "closed for today");
      },
    },
  });
  const l = await space.listen("ws://127.0.0.1:0");
  const p = await Participant.connect(l.address, { reconnect: false });
  await assert.rejects(p.join(), (e: OutcomeError) => e.outcome.reason?.code === "forbidden");
  p.close();
  await space.close();
});

test("an episode handler that takes its time holds up nobody", async () => {
  let release!: () => void;
  const started = new Promise<void>((r) => (release = r));
  let resets = 0;
  const space = new Space({
    vocabulary,
    capabilities: { state: "external", episode: { tasks: ["a"], evaluator: "evaluator" } },
    handlers: {
      observe: () => ({ structure: { things: [] } }),
      episode: async ({ task }) => {
        resets += 1;
        await started;
        return { episode: `e-${task}` };
      },
    },
  });
  const l = await space.listen("ws://127.0.0.1:0");
  try {
    const p = await Participant.connect(l.address, { key: generateKey() });
    await p.join();
    const episode = p.request({ type: "episode", id: "ep-1", task: "a" });
    p.request({ type: "episode", id: "ep-1", task: "a" }); // sent again while it waits
    const seen = await p.observe(); // answered while the episode is being started
    assert.equal(typeof seen.seq, "number");
    release();
    const out = await episode.done;
    assert.equal(out.end, "done");
    assert.equal((out.result as { episode: string }).episode, "e-a");
    assert.equal(resets, 1);
    await p.close();
  } finally {
    await space.close();
  }
});
