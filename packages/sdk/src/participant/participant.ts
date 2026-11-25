/**
 * The participant side: connect, shake hands, enter, observe, subscribe (resuming by sequence
 * number after a disconnect), act with generated IDs, basis and deadlines, receive intermediate
 * states and exactly one final outcome, cancel, and fetch the record and the vocabulary.
 */
import { SDK_PARTS, type Entry, type JSONValue, type Outcome, type Presentation, type SpaceHello, type Structure, type Software, type SupportedParts, type Vocabulary, type Change, type Entries, type Observation, type Subscribed, type JoinResult } from "../types/index.ts";
import { makeProof, type KeyPair } from "../identity.ts";
import { connect, dropConnection, type ConnectOptions, type Connection } from "../transport/index.ts";
import { deferred, randomToken, sleep } from "../util.ts";

/** Options for a participant. */
export interface ParticipantOptions {
  /** The participant's key. Without a key or a token it is anonymous. */
  key?: KeyPair;
  /** A local token, instead of a key. */
  token?: string;
  /** The versions supported for each part; all parts of this SDK by default. */
  parts?: SupportedParts;
  client?: Software;
  /** Reconnect and resume the presence after a dropped connection. On by default. */
  reconnect?: boolean;
  /** How long to keep trying to reconnect, in milliseconds. */
  reconnectFor?: number;
  connect?: ConnectOptions;
}

/** A final answer that is not `done`. */
export class OutcomeError extends Error {
  readonly outcome: Outcome;
  constructor(outcome: Outcome) {
    super(`${outcome.end}${outcome.reason ? `: ${outcome.reason.code}${outcome.reason.text ? ` (${outcome.reason.text})` : ""}` : ""}`);
    this.outcome = outcome;
  }
}

/** An intermediate state of a request. */
export type Update = { type: "accepted" | "progress" | "waiting" | "frame"; [key: string]: unknown };

/** A request under way: its ID, its updates, and its one final answer. */
export interface Pending<T = Outcome> {
  id: string;
  /** Resolves with the final answer. */
  done: Promise<T>;
  /** Called with each intermediate state. */
  onUpdate(fn: (update: Update) => void): Pending<T>;
  /** Asks to cancel it. It still gets its own final answer. */
  cancel(): void;
}

/** What an action is. */
export interface ActOptions {
  verb: string;
  object?: string;
  args?: Record<string, unknown>;
  basis?: number;
  /** Seconds. */
  deadline?: number;
  /** The action ID; generated when absent. */
  id?: string;
  [key: string]: unknown;
}

/** What an edit is. */
export interface EditOptions {
  changes?: Change[];
  sentence?: string;
  basis?: number;
  deadline?: number;
  id?: string;
}

interface Request {
  message: Record<string, unknown>;
  finals: Set<string>;
  resolve: (msg: any) => void;
  promise: Promise<any>;
  updates: ((u: Update) => void)[];
  settled: boolean;
}

type Listener<T> = (value: T) => void;

const FINALS: Record<string, string[]> = {
  observe: ["observation"],
  subscribe: ["subscribed"],
  record: ["entries"],
  vocabulary: ["vocabulary"],
  blob: ["blob"],
};

/** A participant connected to one space. */
export class Participant {
  readonly address: string;
  /** The space's `hello`. */
  hello!: SpaceHello;
  /** The presence, once joined. */
  presence?: JoinResult;
  /** The sequence number of the last record entry received by subscription. */
  lastSeq = 0;
  #opts: ParticipantOptions;
  #conn!: Connection;
  #requests = new Map<string, Request>();
  #outbox: Record<string, unknown>[] = [];
  #listeners = new Map<string, Set<Listener<any>>>();
  #subscription?: { kinds?: string[] };
  #vocabulary?: { hash: string; vocabulary: Vocabulary };
  #connected = false;
  #closing = false;
  #counter = 0;
  #prefix = randomToken(4);
  #helloWaiter = deferred<SpaceHello>();

  private constructor(address: string, options: ParticipantOptions) {
    this.address = address;
    this.#opts = options;
  }

  /** Connects to a space and shakes hands. */
  static async connect(address: string, options: ParticipantOptions = {}): Promise<Participant> {
    const p = new Participant(address, options);
    await p.#open();
    return p;
  }

  /** The negotiated version of each part. */
  get parts(): Record<string, number> {
    return this.hello.parts;
  }

  /** Whether the connection is up. */
  get connected(): boolean {
    return this.#connected;
  }

  /** Listens: `event` (a record entry, each once and in order), `outcome`, `message` (every message), `disconnect`, `reconnect`, `closing`, `lost` (the presence could not be resumed). */
  on(name: "event", fn: Listener<Entry>): () => void;
  on(name: "outcome", fn: Listener<Outcome>): () => void;
  on(name: "message", fn: Listener<Record<string, any>>): () => void;
  on(name: "disconnect" | "reconnect" | "closing" | "lost", fn: Listener<void>): () => void;
  on(name: string, fn: Listener<any>): () => void {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  #fire(name: string, value?: unknown): void {
    for (const fn of this.#listeners.get(name) ?? []) {
      try {
        fn(value);
      } catch (e) {
        console.error(`asp participant: a ${name} listener threw:`, e);
      }
    }
  }

  /** A new request ID. */
  nextId(prefix = "r"): string {
    return `${prefix}${++this.#counter}-${this.#prefix}`;
  }

  async #open(): Promise<void> {
    this.#conn = await connect(this.address, this.#opts.connect);
    this.#helloWaiter = deferred<SpaceHello>();
    this.#conn.onmessage = (text) => this.#onMessage(text);
    this.#conn.onclose = () => this.#onClose();
    this.#conn.send({
      type: "hello",
      parts: this.#opts.parts ?? SDK_PARTS,
      ...(this.#opts.key ? { participant: this.#opts.key.identity } : {}),
      ...(this.#opts.token ? { token: this.#opts.token } : {}),
      client: this.#opts.client ?? { name: "@agent-space-protocol/sdk" },
    });
    const hello = await Promise.race([
      this.#helloWaiter.promise,
      sleep(10000).then(() => {
        throw new Error("no hello from the space");
      }),
    ]);
    this.hello = hello;
    this.#connected = true;
  }

  #onMessage(text: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.#fire("message", msg);
    if (msg.type === "hello") return this.#helloWaiter.resolve(msg as SpaceHello);
    if (msg.type === "error" && !this.hello) return this.#helloWaiter.reject(new Error(`${msg.code}: ${msg.text ?? ""}`));
    if (msg.type === "event") {
      const entry = msg.entry as Entry;
      if (entry.type === "asp.closing") this.#fire("closing");
      if (!this.#subscription) return;
      if (entry.seq <= this.lastSeq) return;
      this.lastSeq = entry.seq;
      this.#fire("event", entry);
      return;
    }
    const id = msg.id ?? (msg.type === "frame" ? msg.stream : undefined);
    const req = id !== undefined ? this.#requests.get(id) : undefined;
    if (!req || req.settled) return;
    if (req.finals.has(msg.type)) {
      req.settled = true;
      this.#requests.delete(id);
      if (msg.type === "outcome") this.#fire("outcome", msg);
      req.resolve(msg);
    } else if (["accepted", "progress", "waiting", "frame"].includes(msg.type)) {
      for (const fn of req.updates) fn(msg as Update);
    }
  }

  #onClose(): void {
    const was = this.#connected;
    this.#connected = false;
    if (this.#closing) return;
    if (was) this.#fire("disconnect");
    if (this.#opts.reconnect === false) {
      for (const [id, req] of this.#requests) {
        req.settled = true;
        req.resolve({ type: "outcome", id, end: "unknown", reason: { code: "closed", text: "the connection closed" }, known: {}, unconfirmed: ["delivered"] });
      }
      this.#requests.clear();
      return;
    }
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    const until = Date.now() + (this.#opts.reconnectFor ?? 60000);
    let wait = 100;
    while (!this.#closing && Date.now() < until) {
      try {
        await this.#open();
        if (this.presence) {
          const res = await this.#raw({ type: "join", id: this.nextId("j"), resume: this.presence.resume, ...this.#proof() });
          if (res.end !== "done") {
            this.presence = undefined;
            this.#fire("lost");
          }
        }
        if (this.#subscription) await this.#raw({ type: "subscribe", id: this.nextId("s"), from: this.lastSeq + 1, ...(this.#subscription.kinds ? { kinds: this.#subscription.kinds } : {}) });
        // Resend every request still waiting: IDs are idempotent, so nothing runs twice.
        for (const req of this.#requests.values()) this.#conn.send(req.message);
        const outbox = this.#outbox;
        this.#outbox = [];
        for (const m of outbox) this.#conn.send(m);
        this.#fire("reconnect");
        return;
      } catch {
        await sleep(wait);
        wait = Math.min(wait * 2, 2000);
      }
    }
  }

  #proof(): { proof?: string } {
    return this.#opts.key ? { proof: makeProof(this.#opts.key, this.hello.space, this.hello.nonce) } : {};
  }

  /** Sends a request and waits for its final answer, without tracking it across reconnects. */
  #raw(message: Record<string, unknown>): Promise<any> {
    return this.request(message).done;
  }

  /**
   * Sends any request and returns it under way. The ID is generated when absent. The final answer
   * is an `outcome`, or the request's reply message (`observation`, `entries`, ...).
   */
  request<T = any>(message: Record<string, unknown>): Pending<T> {
    const id = (message.id as string) ?? this.nextId(String(message.type)[0]);
    const full = { ...message, id };
    const finals = new Set(["outcome", ...(FINALS[String(message.type)] ?? [])]);
    let req = this.#requests.get(id);
    if (!req) {
      const d = deferred<T>();
      req = { message: full, finals, resolve: d.resolve, promise: d.promise, updates: [], settled: false };
      this.#requests.set(id, req);
    }
    if (this.#connected) this.#conn.send(full);
    const r = req;
    const pending: Pending<T> = {
      id,
      done: r.promise,
      onUpdate: (fn) => {
        r.updates.push(fn);
        return pending;
      },
      cancel: () => this.cancel(id),
    };
    return pending;
  }

  /** Sends a message as it is. */
  send(message: Record<string, unknown>): void {
    if (this.#connected) this.#conn.send(message);
    else this.#outbox.push(message);
  }

  /** Sends raw text, for tests. */
  sendRaw(text: string): void {
    this.#conn.sendRaw(text);
  }

  /** Enters the space. Throws `OutcomeError` when refused. */
  async join(options: { role?: string; presentation?: Presentation; pass?: string } = {}): Promise<JoinResult> {
    const res: Outcome = await this.#raw({ type: "join", ...options, ...this.#proof() });
    if (res.end !== "done") throw new OutcomeError(res);
    this.presence = res.result as unknown as JoinResult;
    if (this.lastSeq === 0) this.lastSeq = this.presence.head;
    return this.presence;
  }

  /** Leaves the space. */
  async leave(cancel = false): Promise<Outcome> {
    const res: Outcome = await this.#raw({ type: "leave", ...(cancel ? { cancel } : {}) });
    this.presence = undefined;
    this.#subscription = undefined;
    return res;
  }

  /** One observation. Throws `OutcomeError` when refused. */
  async observe(forms?: string[]): Promise<Observation> {
    const res = await this.#raw({ type: "observe", ...(forms ? { forms } : {}) });
    if (res.type === "outcome") throw new OutcomeError(res);
    return res;
  }

  /**
   * Subscribes to the record from a sequence number on (the next new entry by default). Entries
   * arrive through `on("event")`, each once and in order; after a reconnect the subscription
   * continues from the last one received.
   */
  async subscribe(options: { from?: number; kinds?: string[] } = {}): Promise<Subscribed> {
    const res = await this.#raw({ type: "subscribe", ...options });
    if (res.type === "outcome") throw new OutcomeError(res);
    this.#subscription = { kinds: options.kinds };
    this.lastSeq = res.from - 1;
    return res;
  }

  /** Takes an action. */
  act(options: ActOptions): Pending<Outcome> {
    const { id, ...rest } = options;
    return this.request<Outcome>({ type: "act", ...(id ? { id } : { id: this.nextId("a") }), ...rest });
  }

  /** Edits the world. */
  edit(options: EditOptions): Pending<Outcome> {
    const { id, ...rest } = options;
    return this.request<Outcome>({ type: "edit", ...(id ? { id } : { id: this.nextId("e") }), ...rest });
  }

  /** Asks to cancel a request of this participant. */
  cancel(id: string): void {
    this.send({ type: "cancel", action: id });
  }

  /** Fetches the record. */
  async record(range: { from?: number; to?: number; since?: string; until?: string; limit?: number } = {}): Promise<Entries> {
    const res = await this.#raw({ type: "record", ...range });
    if (res.type === "outcome") throw new OutcomeError(res);
    return res;
  }

  /** Fetches the vocabulary, cached by hash. */
  async vocabulary(): Promise<Vocabulary> {
    if (this.#vocabulary?.hash === this.hello.vocabulary) return this.#vocabulary.vocabulary;
    const res = await this.#raw({ type: "vocabulary" });
    if (res.type === "outcome") throw new OutcomeError(res);
    this.#vocabulary = { hash: res.hash, vocabulary: res.vocabulary };
    return res.vocabulary;
  }

  /** Fetches large content by hash. */
  async blob(hash: string): Promise<{ media: string; data: Buffer }> {
    const res = await this.#raw({ type: "blob", hash });
    if (res.type === "outcome") throw new OutcomeError(res);
    return { media: res.media, data: Buffer.from(res.data, "base64") };
  }

  /** Drops the connection as a network failure would; the participant reconnects and resumes. For tests. */
  drop(): void {
    dropConnection(this.#conn);
  }

  /** Closes the connection for good. */
  close(): void {
    this.#closing = true;
    this.#connected = false;
    this.#conn?.close();
  }
}

/** The things of an observation, by ID. */
export function thingsById(structure: Structure): Map<string, Record<string, JSONValue>> {
  return new Map(structure.things.map((t) => [t.id, t as Record<string, JSONValue>]));
}
