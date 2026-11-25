/**
 * The space skeleton. It keeps the protocol's guarantees for the implementer: exactly one final
 * outcome for every action (deadlines, cancels, closing and restarts included), idempotent request
 * IDs, `basis` and staleness, `unsupported` for what is not declared, `malformed` for broken
 * messages with an ID, the record by sequence number with subscriptions, resuming and expiry,
 * projection by role, presences kept for a grace period, consent, pausing, doors.
 *
 * The implementer writes only how verbs are carried out and what the state looks like.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import {
  CAPABILITY_PARTS,
  MESSAGE_CAPABILITY,
  PARTICIPANT_MESSAGES,
  validate,
  type Act,
  type Capabilities,
  type Change,
  type Edit,
  type Effect,
  type Entry,
  type FormContent,
  type JSONValue,
  type NegotiatedParts,
  type OfferedThing,
  type ParticipantHello,
  type Presentation,
  type PresentationUse,
  type Reason,
  type Role,
  type Software,
  type Structure,
  type SupportedParts,
  type View,
  type Vocabulary,
} from "../types/index.ts";
import { checkProof, generateKey, makePass, peekPass, readPass, type KeyPair } from "../identity.ts";
import { listen, type Connection, type Listener } from "../transport/index.ts";
import { canonicalJson, contentHash, deferred, isObject, now, randomToken } from "../util.ts";
import { Failed, Refused, Stopped, Uncertain } from "./errors.ts";
import { MemoryStore, type NewEntry, type Store, type StoredRequest } from "./store.ts";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

/** Who is acting: a presence, its role and its participant. */
export interface PresenceInfo {
  id: string;
  role: string;
  participant?: string;
}

/** What the observe handler is given. */
export interface ObserveContext {
  presence: PresenceInfo;
  /** The forms asked for besides structure, all declared. */
  forms: string[];
}

/** What the observe handler returns. The skeleton removes what the role may not see. */
export interface ObserveResult {
  structure: Structure;
  forms?: Record<string, FormContent>;
  confirmed?: string;
}

/** Options for an event a law emits. */
export interface EmitOptions {
  /** The things involved; listing a thing marks it changed for `basis`. */
  things?: string[];
  /** Only these roles receive it. */
  roles?: string[];
}

/** What a law is given while it carries out an action, an edit or a stream. */
export interface RequestContext {
  /** The request ID. */
  id: string;
  presence: PresenceInfo;
  /** The sequence number of the request's `asp.act` or `asp.edit` entry. */
  actSeq?: number;
  /** Aborts when the action is asked to stop: on cancel, deadline or closing. */
  signal: AbortSignal;
  /** Why it was asked to stop, once it was. */
  readonly stopReason: "cancel" | "deadline" | "closed" | undefined;
  /** Reports progress. */
  progress(progress?: number, text?: string): void;
  /** Emits an event, appended with the outcome in one commit. */
  emit(kind: string, data?: JSONValue, options?: EmitOptions): void;
  /** Waits while the action is paused; throws `Stopped` when it is asked to stop. */
  checkpoint(): Promise<void>;
  /** Waits, counting only time not paused; throws `Stopped` when asked to stop. */
  sleep(ms: number): Promise<void>;
}

/** What an action's law is given. */
export interface ActionContext extends RequestContext {
  verb: string;
  object?: string;
  args: Record<string, unknown>;
  basis?: number;
}

/** What an edit's law is given. */
export interface EditContext extends RequestContext {
  changes?: Change[];
  sentence?: string;
  basis?: number;
}

/** What a stream is given. */
export interface StreamContext extends RequestContext {
  form: string;
  rate?: number;
  /** Sends one frame. */
  frame(content: FormContent): void;
}

/** What a law returns for `done`. */
export interface ActResult {
  result?: JSONValue;
  /** Things changed by an edit, listed in its outcome entry. */
  things?: string[];
}

/** The handlers a space implementer writes. Only `observe` is required. */
export interface SpaceHandlers {
  /** The state as this presence may see it. Should be synchronous for a space that holds its state. */
  observe(ctx: ObserveContext): ObserveResult | Promise<ObserveResult>;
  /** Laws by verb. */
  verbs?: Record<string, (ctx: ActionContext) => ActResult | void | Promise<ActResult | void>>;
  /** The things an action touches besides its object, for staleness. */
  touches?(action: Act): string[];
  /** Carries out an edit atomically. */
  edit?(ctx: EditContext): ActResult | void | Promise<ActResult | void>;
  /** Decides the role of a joining participant. Throw `Refused` to refuse. */
  admit?(request: { participant?: string; role: string; pass?: Record<string, unknown> }): string;
  /** Decides what is done with presentation preferences. */
  presentation?(presentation: Presentation): Record<string, PresentationUse>;
  /** Capability `episode`. */
  episode?(request: { task?: string; seed?: number; presence: PresenceInfo }): { episode: string } & Record<string, JSONValue>;
  score?(request: { episode?: string; presence: PresenceInfo }): { episode: string; score: JSONValue };
  /** Capability `snapshot`. */
  snapshot?(): JSONValue;
  restore?(snapshot: JSONValue): void;
  /** Capability `senses`: computes a derived observation. */
  sense?(language: string, query: string, structure: Structure, presence: PresenceInfo): JSONValue;
  /** Capability `views`. */
  views?(): View[];
  /** Capability `doors`: takes a thing handed over. `as` is the nearest type this space knows. */
  take?(request: { thing: OfferedThing; as: string; from?: string; door?: string }): { thing: string };
  /** Capability `forms`: produces frames until the signal aborts. */
  stream?(ctx: StreamContext): Promise<void>;
}

/** Options of a space. */
export interface SpaceOptions {
  /** The identifier; the key's identity by default. */
  id?: string;
  /** The space's key, made at start when absent. */
  key?: KeyPair;
  capabilities: Capabilities;
  vocabulary: Vocabulary;
  /** The versions supported for each part; by default the core and each declared capability's part, at 0. */
  parts?: SupportedParts;
  /** Where the record is kept; in memory by default. */
  store?: Store;
  /** How long the record is kept, in seconds; for ever by default. */
  keepSeconds?: number | null;
  /** Local tokens and the names they stand for. */
  tokens?: Record<string, string>;
  server?: Software;
  /** Namespaced members added to `hello`. */
  hello?: Record<string, unknown>;
  /** How long a law has to stop after being asked, before the outcome is `unknown`. */
  stopGraceMs?: number;
  handlers: SpaceHandlers;
}

interface Session {
  conn: Connection;
  hello?: ParticipantHello;
  parts?: NegotiatedParts;
  token?: string;
  nonce: string;
  presence?: Presence;
}

interface Presence {
  id: string;
  role: string;
  participant?: string;
  /** The prefix of request keys: the participant's identity, or the presence for an anonymous one. */
  key: string;
  resume: string;
  session?: Session;
  sub?: { cursor: number; kinds?: string[] };
  senses: Map<string, { language: string; query: string }>;
  grace?: NodeJS.Timeout;
  ended: boolean;
}

interface Running {
  key: string;
  id: string;
  type: "act" | "edit" | "stream";
  presence: Presence;
  actSeq?: number;
  controller: AbortController;
  stopReason?: "cancel" | "deadline" | "closed";
  paused: boolean;
  resumeWaiters: (() => void)[];
  events: NewEntry[];
  stored: StoredRequest;
  finished: boolean;
  settled: Promise<void>;
  verb?: string;
  consent?: { by: string; resolve: (agree: boolean | "timeout" | "stopped") => void };
  deadline?: NodeJS.Timeout;
}

/** Kinds of entry that do not change the things they list. */
const NOT_CHANGES = new Set([
  "asp.act",
  "asp.edit",
  "asp.cancel",
  "asp.waiting",
  "asp.consent",
  "asp.join",
  "asp.leave",
  "asp.episode",
  "asp.score",
  "asp.snapshot",
  "asp.closing",
  "asp.restarted",
]);

/** Request types whose IDs are remembered so that they are never carried out twice. */
const IDEMPOTENT = new Set(["act", "edit", "leave", "stream", "consent", "snapshot", "restore", "episode", "pause", "resume", "sense", "offer"]);

const DEFAULT_ROLES: Record<string, Role> = {
  owner: { verbs: ["*"], edit: true, consent: true },
  member: { verbs: ["*"] },
  guest: { verbs: [] },
};

/** A space: accepts connections and keeps the protocol for its handlers. */
export class Space {
  readonly id: string;
  readonly key: KeyPair;
  readonly capabilities: Capabilities;
  readonly vocabulary: Vocabulary;
  readonly vocabularyHash: string;
  readonly parts: SupportedParts;
  readonly store: Store;
  readonly keepSeconds: number | null;
  #h: SpaceHandlers;
  #opts: SpaceOptions;
  #sessions = new Set<Session>();
  #presences = new Map<string, Presence>();
  #byResume = new Map<string, Presence>();
  #running = new Map<string, Running>();
  #lastChange = new Map<string, number>();
  #lastRestore = 0;
  #presenceCounter = 0;
  #listeners: Listener[] = [];
  #blobs = new Map<string, { media: string; data: Buffer }>();
  #paramValidators = new Map<string, ValidateFunction>();
  #ajv: Ajv2020;
  #pruneTimer?: NodeJS.Timeout;
  #closing = false;
  #closed = deferred<void>();
  #prunedBefore?: string;

  constructor(options: SpaceOptions) {
    this.#opts = options;
    this.#h = options.handlers;
    this.key = options.key ?? generateKey();
    this.id = options.id ?? this.key.identity;
    this.capabilities = options.capabilities;
    this.vocabulary = options.vocabulary;
    this.vocabularyHash = contentHash(options.vocabulary);
    this.#blobs.set(this.vocabularyHash, { media: "application/json", data: Buffer.from(canonicalJson(options.vocabulary)) });
    this.store = options.store ?? new MemoryStore();
    this.keepSeconds = options.keepSeconds ?? null;
    this.parts = options.parts ?? defaultParts(options.capabilities);
    this.#ajv = new Ajv2020({ strict: false });
    addFormats(this.#ajv);
    this.#prunedBefore = this.store.getMeta("pruned_before");
    for (const e of this.store.read({})) this.#noteChanges(e);
    this.#recover();
    if (this.keepSeconds !== null) {
      this.#pruneTimer = setInterval(() => this.#prune(), Math.min(1000, this.keepSeconds * 250));
      this.#pruneTimer.unref();
    }
  }

  /** The latest sequence number. */
  get head(): number {
    return this.store.head();
  }

  /** Listens at an address: `ws://host:port`, `http://host:port` or `stdio`. */
  async listen(address: string): Promise<Listener> {
    const l = await listen(address, (conn) => this.accept(conn));
    this.#listeners.push(l);
    return l;
  }

  /** Resolves when the space has closed. */
  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  /** Stores large content and returns its hash, for forms, presentation and views. */
  putBlob(data: Buffer | string, media: string): string {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const hash = contentHash(bytes);
    this.#blobs.set(hash, { media, data: bytes });
    return hash;
  }

  /**
   * Appends an event that no participant's action caused: from the space itself, or from a
   * participant outside the protocol (`source: "outside/<who>"`).
   */
  emit(kind: string, data?: JSONValue, options: EmitOptions & { source?: string; cause?: number } = {}): Entry {
    const [entry] = this.#append([{ source: options.source ?? "space", type: kind, data, things: options.things, roles: options.roles, cause: options.cause }]);
    return entry;
  }

  /** Takes a new connection. */
  accept(conn: Connection): void {
    if (this.#closing) {
      conn.close();
      return;
    }
    const session: Session = { conn, nonce: randomToken(24) };
    this.#sessions.add(session);
    conn.onmessage = (text) => {
      try {
        this.#onMessage(session, text);
      } catch (e) {
        console.error("asp space: error handling a message:", e);
      }
    };
    conn.onclose = () => this.#onDisconnect(session);
  }

  /**
   * Closes the space: every action under way first gets its final outcome, then `asp.closing` is
   * appended and sent to every connection, and the connections close.
   */
  async close(): Promise<void> {
    if (this.#closing) return this.#closed.promise;
    this.#closing = true;
    const all = [...this.#running.values()];
    for (const r of all) this.#stop(r, "closed");
    await Promise.all(all.map((r) => r.settled));
    const [closing] = this.#append([{ source: "space", type: "asp.closing" }]);
    for (const s of this.#sessions) {
      if (!s.presence?.sub) s.conn.send({ type: "event", entry: closing });
    }
    for (const s of [...this.#sessions]) s.conn.close();
    for (const p of this.#presences.values()) if (p.grace) clearTimeout(p.grace);
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    await Promise.all(this.#listeners.map((l) => l.close()));
    this.store.close();
    this.#closed.resolve();
  }

  /* ───────────────────────────── Messages ───────────────────────────── */

  #onMessage(session: Session, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.#error(session, "malformed", "not JSON");
    }
    if (!isObject(msg)) return this.#error(session, "malformed", "not a JSON object");
    const id = typeof msg.id === "string" && msg.id.length >= 1 && msg.id.length <= 128 ? msg.id : undefined;
    const type = msg.type;
    if (typeof type !== "string") return id ? this.#refuseRequest(session, msg, id, "malformed", "no type") : this.#error(session, "malformed", "no type");
    if (!session.parts) {
      if (type !== "hello") return this.#error(session, "malformed", "the handshake comes first", type);
      return this.#onHello(session, msg);
    }
    if (type === "hello") return this.#error(session, "malformed", "the handshake is already done", type);
    const def = PARTICIPANT_MESSAGES[type];
    if (!def) return id ? this.#refuseRequest(session, msg, id, "unsupported", `unknown message type ${type}`) : this.#error(session, "unsupported", `unknown message type ${type}`, type);
    const capability = MESSAGE_CAPABILITY[type];
    if (capability) {
      const declared = (this.capabilities as Record<string, unknown>)[capability] !== undefined;
      const negotiated = capability === "edit" || session.parts[capability] !== undefined;
      if (!declared || !negotiated) {
        const why = !declared ? `capability ${capability} is not declared` : `part ${capability} was not negotiated`;
        return id ? this.#refuseRequest(session, msg, id, "unsupported", why) : this.#error(session, "unsupported", why, type);
      }
    }
    const invalid = validate(def, msg);
    if (invalid) return id ? this.#refuseRequest(session, msg, id, "malformed", invalid) : this.#error(session, "malformed", invalid, type);
    const presence = session.presence;
    if (!presence && !["join", "vocabulary", "blob"].includes(type)) {
      return id ? this.#refuseRequest(session, msg, id, "forbidden", "join first") : this.#error(session, "forbidden", "join first", type);
    }
    if (presence && id && IDEMPOTENT.has(type)) {
      const stored = this.store.getRequest(reqKey(presence, id));
      if (stored) {
        if (stored.state === "final") session.conn.send(stored.final!);
        else session.conn.send(this.#running.get(stored.key)?.stored.last ?? stored.last ?? { type: "accepted", id, seq: stored.act });
        return;
      }
    }
    const m = msg as any;
    switch (type) {
      case "join":
        return this.#onJoin(session, m);
      case "leave":
        return this.#onLeave(presence!, m);
      case "observe":
        return void this.#onObserve(presence!, m);
      case "subscribe":
        return this.#onSubscribe(presence!, m);
      case "act":
        return this.#onAct(presence!, m);
      case "edit":
        return this.#onEdit(presence!, m);
      case "cancel":
        return this.#onCancel(presence!, m);
      case "record":
        return this.#onRecord(presence!, m);
      case "vocabulary":
        if (m.hash && m.hash !== this.vocabularyHash) return this.#answerRefusal(session, id!, "expired", "that vocabulary is not kept");
        return session.conn.send({ type: "vocabulary", id, hash: this.vocabularyHash, vocabulary: this.vocabulary });
      case "blob": {
        const b = this.#blobs.get(m.hash);
        if (!b) return this.#answerRefusal(session, id!, "expired", "no content with that hash is kept");
        return session.conn.send({ type: "blob", id, hash: m.hash, media: b.media, data: b.data.toString("base64") });
      }
      case "stream":
        return this.#onStream(presence!, m);
      case "consent":
        return this.#onConsent(presence!, m);
      case "snapshot":
      case "restore":
        return this.#onSnapshot(presence!, m);
      case "episode":
      case "score":
        return this.#onEpisode(presence!, m);
      case "pause":
      case "resume":
        return this.#onPause(presence!, m);
      case "sense":
        return this.#onSense(presence!, m);
      case "views":
        return this.#finishSimple(presence!, m, { end: "done", result: { views: this.#h.views?.() ?? [] } as unknown as JSONValue }, false);
      case "offer":
        return this.#onOffer(presence!, m);
      case "take":
        return void this.#onTake(presence!, m);
    }
  }

  #error(session: Session, code: string, text: string, about?: string): void {
    session.conn.send({ type: "error", code, text, ...(about ? { about } : {}) });
  }

  /** Refuses a request: recorded when it is an action or edit of a presence. */
  #refuseRequest(session: Session, msg: Record<string, any>, id: string, code: string, text: string): void {
    const presence = session.presence;
    if (presence && (msg.type === "act" || msg.type === "edit")) {
      const key = reqKey(presence, id);
      const stored = this.store.getRequest(key);
      if (stored) {
        session.conn.send(stored.state === "final" ? stored.final! : (stored.last ?? { type: "accepted", id }));
        return;
      }
      this.#finishRecorded(presence, { key, type: msg.type, state: "running", presence: presence.id }, id, undefined, [], {
        end: "refused",
        reason: { code, text },
      });
      return;
    }
    this.#answerRefusal(session, id, code, text);
  }

  #answerRefusal(session: Session, id: string, code: string, text: string, data?: JSONValue): void {
    session.conn.send({ type: "outcome", id, end: "refused", reason: { code, text, ...(data !== undefined ? { data } : {}) } });
  }

  /* ───────────────────────────── Handshake and presences ───────────────────────────── */

  #onHello(session: Session, msg: Record<string, any>): void {
    const invalid = validate("ParticipantHello", msg);
    if (invalid) return this.#error(session, "malformed", invalid, "hello");
    const parts: Record<string, number> = {};
    for (const [part, versions] of Object.entries(this.parts)) {
      const theirs = msg.parts[part];
      if (!Array.isArray(theirs)) continue;
      const common = versions.filter((v) => theirs.includes(v));
      if (common.length) parts[part] = Math.max(...common);
    }
    if (parts.core === undefined) {
      this.#error(session, "unsupported", "no common version of the core", "hello");
      session.conn.close();
      return;
    }
    if (msg.token !== undefined) {
      const name = this.#opts.tokens?.[msg.token];
      if (!name) {
        this.#error(session, "forbidden", "unknown token", "hello");
        session.conn.close();
        return;
      }
      session.token = name;
    }
    session.hello = msg as ParticipantHello;
    session.parts = parts as NegotiatedParts;
    session.conn.send({
      type: "hello",
      space: this.id,
      parts,
      supported: this.parts,
      capabilities: this.capabilities,
      vocabulary: this.vocabularyHash,
      record: { head: this.store.head(), earliest: this.store.earliest(), keep_seconds: this.keepSeconds },
      nonce: session.nonce,
      key: this.key.identity,
      ...(this.#opts.server ? { server: this.#opts.server } : {}),
      ...(this.#opts.hello ?? {}),
    });
  }

  #roles(): Record<string, Role> {
    return this.capabilities.participants?.roles ?? DEFAULT_ROLES;
  }

  #onJoin(session: Session, msg: Record<string, any>): void {
    const id: string = msg.id;
    const refuse = (code: string, text: string) => this.#answerRefusal(session, id, code, text);
    let participant: string | undefined;
    if (session.hello?.participant) {
      if (!msg.proof || !checkProof(session.hello.participant, this.id, session.nonce, msg.proof)) return refuse("forbidden", "no valid proof of identity");
      participant = session.hello.participant;
    } else if (session.token) participant = `token:${session.token}`;

    if (msg.resume !== undefined) {
      const p = this.#byResume.get(msg.resume);
      if (!p || p.ended) return refuse("closed", "no presence to resume");
      if (p.participant !== participant) return refuse("forbidden", "the presence belongs to another participant");
      if (session.presence && session.presence !== p) return refuse("malformed", "this connection already has a presence");
      if (p.grace) clearTimeout(p.grace);
      p.grace = undefined;
      if (p.session && p.session !== session) {
        p.session.presence = undefined;
        p.session.conn.close();
      }
      p.session = session;
      p.sub = undefined;
      session.presence = p;
      const [entry] = this.#append([{ source: `presence/${p.id}`, type: "asp.join", data: { presence: p.id, role: p.role, participant: p.participant ?? null, resumed: true } }]);
      session.conn.send({
        type: "outcome",
        id,
        end: "done",
        seq: entry.seq,
        result: { presence: p.id, role: p.role, ...(p.participant ? { participant: p.participant } : {}), resume: p.resume, resumed: true, head: entry.seq },
      });
      return;
    }
    if (session.presence) return refuse("malformed", "this connection already has a presence");

    let passPayload: Record<string, unknown> | undefined;
    if (msg.pass !== undefined) {
      const issuer = peekPass(msg.pass)?.from;
      const door = this.capabilities.doors?.doors?.find((d) => d.space && d.space === issuer);
      const payload = door && issuer ? readPass(msg.pass, issuer) : undefined;
      if (!payload || payload.participant !== participant) return refuse("forbidden", "the pass is not valid for this participant");
      passPayload = payload as unknown as Record<string, unknown>;
    }
    const roles = this.#roles();
    let role: string = msg.role ?? this.capabilities.participants?.default_role ?? Object.keys(roles)[0];
    if (!roles[role]) return refuse("forbidden", `no role ${role}`);
    if (this.#h.admit) {
      try {
        role = this.#h.admit({ participant, role, pass: passPayload });
      } catch (e) {
        if (e instanceof Refused) return refuse(e.code, e.text ?? e.code);
        throw e;
      }
    }
    const max = this.capabilities.participants?.max;
    const active = [...this.#presences.values()].filter((p) => !p.ended).length;
    if (max !== undefined && active >= max) return refuse("forbidden", "the space is full");

    const presence: Presence = {
      id: `p-${++this.#presenceCounter}-${randomToken(3)}`,
      role,
      participant,
      key: "",
      resume: randomToken(18),
      session,
      senses: new Map(),
      ended: false,
    };
    presence.key = participant ?? `presence:${presence.id}`;
    this.#presences.set(presence.id, presence);
    this.#byResume.set(presence.resume, presence);
    session.presence = presence;
    const presentation = msg.presentation
      ? (this.#h.presentation?.(msg.presentation) ?? Object.fromEntries(Object.keys(msg.presentation).map((k) => [k, "ignored" as PresentationUse])))
      : undefined;
    const [entry] = this.#append([
      { source: `presence/${presence.id}`, type: "asp.join", data: { presence: presence.id, role, participant: participant ?? null, ...(passPayload ? { door: passPayload.door as string } : {}) } },
    ]);
    session.conn.send({
      type: "outcome",
      id,
      end: "done",
      seq: entry.seq,
      result: {
        presence: presence.id,
        role,
        ...(participant ? { participant } : {}),
        ...(presentation ? { presentation } : {}),
        resume: presence.resume,
        head: entry.seq,
      },
    });
  }

  #onLeave(presence: Presence, msg: Record<string, any>): void {
    if (msg.cancel) for (const r of this.#running.values()) if (r.presence === presence) this.#stop(r, "cancel");
    const entry = this.#endPresence(presence, "left");
    const final = { type: "outcome", id: msg.id, end: "done", seq: entry.seq };
    this.store.putRequest({ key: reqKey(presence, msg.id), type: "leave", state: "final", presence: presence.id, final });
    const session = presence.session;
    if (session) {
      session.conn.send(final);
      session.presence = undefined;
    }
    presence.session = undefined;
  }

  #endPresence(presence: Presence, reason: string): Entry {
    presence.ended = true;
    presence.sub = undefined;
    if (presence.grace) clearTimeout(presence.grace);
    this.#byResume.delete(presence.resume);
    const [entry] = this.#append([{ source: `presence/${presence.id}`, type: "asp.leave", data: { presence: presence.id, reason } }]);
    return entry;
  }

  #onDisconnect(session: Session): void {
    this.#sessions.delete(session);
    const p = session.presence;
    if (!p || p.session !== session) return;
    p.session = undefined;
    p.sub = undefined;
    if (this.#closing || p.ended) return;
    const grace = this.capabilities.participants?.grace_seconds ?? 300;
    p.grace = setTimeout(() => {
      if (!p.session && !p.ended) this.#endPresence(p, "closed");
    }, grace * 1000);
    p.grace.unref();
  }

  /* ───────────────────────────── Observing and the record ───────────────────────────── */

  #hidden(role: string) {
    return this.#roles()[role]?.hide ?? {};
  }

  async #onObserve(presence: Presence, msg: Record<string, any>): Promise<void> {
    const forms: string[] = (msg.forms ?? []).filter((f: string) => f !== "structure");
    const declared = this.capabilities.forms ?? [];
    const missing = forms.find((f) => !declared.includes(f) || !this.vocabulary.forms?.[f]);
    if (missing) return this.#answerRefusal(presence.session!, msg.id, "unsupported", `form ${missing} is not declared`);
    const seq = this.store.head();
    const info = presenceInfo(presence);
    let result: ObserveResult;
    try {
      result = await this.#h.observe({ presence: info, forms });
    } catch (e) {
      if (e instanceof Refused) return this.#answerRefusal(presence.session!, msg.id, e.code, e.text ?? e.code, e.data);
      throw e;
    }
    const hide = this.#hidden(presence.role).properties ?? [];
    const structure: Structure = {
      things: result.structure.things.map((t) => stripProps(t, hide) as any),
      ...(result.structure.relations ? { relations: result.structure.relations } : {}),
    };
    const senses: Record<string, JSONValue> = {};
    for (const [name, s] of presence.senses) {
      try {
        senses[name] = this.#h.sense?.(s.language, s.query, structure, info) ?? null;
      } catch {
        senses[name] = null;
      }
    }
    presence.session?.conn.send({
      type: "observation",
      id: msg.id,
      seq,
      ...(result.confirmed ? { confirmed: result.confirmed } : {}),
      structure,
      ...(result.forms && Object.keys(result.forms).length ? { forms: result.forms } : {}),
      ...(presence.senses.size ? { senses } : {}),
    });
  }

  #visible(e: Entry, presence: Presence): boolean {
    if (e.roles && !e.roles.includes(presence.role)) return false;
    if (this.#hidden(presence.role).events?.includes(e.type)) return false;
    return true;
  }

  #project(e: Entry, presence: Presence): Entry {
    const hide = this.#hidden(presence.role).properties ?? [];
    if (!hide.length || !isObject(e.data)) return e;
    return { ...e, data: stripProps(e.data as Record<string, unknown>, hide) as JSONValue };
  }

  #onSubscribe(presence: Presence, msg: Record<string, any>): void {
    const head = this.store.head();
    const from: number = msg.from ?? head + 1;
    if (from < this.store.earliest()) {
      return this.#answerRefusal(presence.session!, msg.id, "expired", `the record starts at ${this.store.earliest()}`, { earliest: this.store.earliest() });
    }
    presence.sub = { cursor: Math.max(from, 1), kinds: msg.kinds };
    presence.session!.conn.send({ type: "subscribed", id: msg.id, from: Math.max(from, 1), head });
    this.#pump(presence);
  }

  /** Pushes every entry from the presence's cursor to the head, each exactly once. */
  #pump(presence: Presence): void {
    const sub = presence.sub;
    const session = presence.session;
    if (!sub || !session) return;
    while (sub.cursor <= this.store.head()) {
      if (sub.cursor < this.store.earliest()) sub.cursor = this.store.earliest();
      const batch = this.store.read({ from: sub.cursor, limit: 500 });
      if (!batch.length) {
        sub.cursor = this.store.head() + 1;
        break;
      }
      for (const e of batch) {
        sub.cursor = e.seq + 1;
        if (!this.#visible(e, presence)) continue;
        if (sub.kinds && !sub.kinds.includes(e.type)) continue;
        session.conn.send({ type: "event", entry: this.#project(e, presence) });
      }
    }
  }

  #onRecord(presence: Presence, msg: Record<string, any>): void {
    const earliest = this.store.earliest();
    const expired =
      (msg.from !== undefined && msg.from < earliest) ||
      (msg.since !== undefined && this.#prunedBefore !== undefined && msg.since < this.#prunedBefore) ||
      (msg.from === undefined && msg.since === undefined && earliest > 1);
    if (expired) return this.#answerRefusal(presence.session!, msg.id, "expired", `the record starts at ${earliest}`, { earliest });
    const limit = Math.min(msg.limit ?? 1000, 1000);
    const out: Entry[] = [];
    let more = false;
    let from: number = msg.from ?? 1;
    for (;;) {
      const batch = this.store.read({ from, to: msg.to, since: msg.since, until: msg.until, limit: 500 });
      if (!batch.length) break;
      for (const e of batch) {
        from = e.seq + 1;
        if (!this.#visible(e, presence)) continue;
        if (out.length >= limit) {
          more = true;
          break;
        }
        out.push(this.#project(e, presence));
      }
      if (more || batch.length < 500) break;
    }
    presence.session!.conn.send({ type: "entries", id: msg.id, entries: out, head: this.store.head(), earliest, ...(more ? { more } : {}) });
  }

  #append(entries: NewEntry[]): Entry[] {
    const out = this.store.append(entries);
    for (const e of out) this.#noteChanges(e);
    for (const p of this.#presences.values()) this.#pump(p);
    return out;
  }

  #noteChanges(e: Entry): void {
    if (e.type === "asp.restore") this.#lastRestore = e.seq;
    if (!e.things || NOT_CHANGES.has(e.type)) return;
    for (const t of e.things) this.#lastChange.set(t, e.seq);
  }

  #prune(): void {
    if (this.keepSeconds === null) return;
    const before = new Date(Date.now() - this.keepSeconds * 1000).toISOString();
    const earliest = this.store.earliest();
    this.store.prune(before);
    if (this.store.earliest() !== earliest) {
      this.#prunedBefore = before;
      this.store.setMeta("pruned_before", before);
    }
  }

  /* ───────────────────────────── Actions, edits and streams ───────────────────────────── */

  #paramValidator(verb: string, schema: object): ValidateFunction {
    let v = this.#paramValidators.get(verb);
    if (!v) {
      v = this.#ajv.compile(schema);
      this.#paramValidators.set(verb, v);
    }
    return v;
  }

  #isStale(things: string[], basis: number | undefined): string | undefined {
    if (basis === undefined) return undefined;
    if (this.#lastRestore > basis) return "a save was restored";
    for (const t of things) {
      const changed = this.#lastChange.get(t);
      if (changed !== undefined && changed > basis) return `${t} changed at ${changed}, after basis ${basis}`;
    }
    return undefined;
  }

  #onAct(presence: Presence, msg: Act): void {
    const key = reqKey(presence, msg.id);
    const [actEntry] = this.#append([
      {
        source: `presence/${presence.id}`,
        type: "asp.act",
        data: stripUndefined({ presence: presence.id, id: msg.id, verb: msg.verb, object: msg.object, args: msg.args as JSONValue, basis: msg.basis, deadline: msg.deadline }) as JSONValue,
      },
    ]);
    const stored: StoredRequest = { key, type: "act", state: "running", act: actEntry.seq, presence: presence.id, request: msg as unknown as Record<string, unknown> };
    this.store.putRequest(stored);
    const refuse = (code: string, text: string, data?: JSONValue) =>
      this.#finishRecorded(presence, stored, msg.id, actEntry.seq, [], { end: "refused", reason: { code, text, ...(data !== undefined ? { data } : {}) } });

    const decl = this.vocabulary.verbs?.[msg.verb];
    if (!decl) return refuse("unsupported", `no verb ${msg.verb} in the vocabulary`);
    const role = this.#roles()[presence.role] ?? {};
    const verbs = role.verbs ?? [];
    if (!verbs.includes("*") && !verbs.includes(msg.verb)) return refuse("forbidden", `role ${presence.role} may not use ${msg.verb}`);
    if (decl.object && msg.object === undefined) return refuse("malformed", `${msg.verb} needs an object`);
    if (decl.params) {
      const v = this.#paramValidator(msg.verb, decl.params);
      if (!v(msg.args ?? {})) {
        const e = v.errors?.[0];
        return refuse("malformed", `args${e?.instancePath ?? ""} ${e?.message ?? "do not match the parameters"}`);
      }
    }
    if (msg.basis !== undefined && msg.basis > this.store.head()) return refuse("malformed", `basis ${msg.basis} is beyond the head of the record`);
    if (decl.stale === "refuse") {
      const touched = [...(msg.object ? [msg.object] : []), ...(this.#h.touches?.(msg) ?? [])];
      const stale = this.#isStale(touched, msg.basis);
      if (stale) return refuse("stale", stale);
    }
    const law = this.#h.verbs?.[msg.verb];
    const run = (ctx: ActionContext) => {
      if (law) return law(ctx);
      if (decl.default.end === "done") return undefined;
      const r = decl.default.reason ?? { code: "forbidden" };
      throw new Refused(r.code, r.text ?? "no law applies", r.data);
    };
    const running = this.#startRunning(presence, "act", msg.id, stored, actEntry.seq, msg.deadline);
    running.verb = msg.verb;
    const consentRule = this.capabilities.consent?.verbs?.[msg.verb];
    const ctx = this.#context(running) as ActionContext;
    Object.assign(ctx, { verb: msg.verb, object: msg.object, args: msg.args ?? {}, basis: msg.basis });
    running.settled = (async () => {
      if (consentRule) {
        const until = new Date(Date.now() + consentRule.seconds * 1000).toISOString();
        this.#append([
          { source: `presence/${presence.id}`, type: "asp.waiting", cause: actEntry.seq, data: { presence: presence.id, id: msg.id, for: { role: consentRule.by }, until } },
        ]);
        const waiting = { type: "waiting", id: msg.id, for: { role: consentRule.by }, act: actEntry.seq, until };
        this.#intermediate(running, waiting, true);
        const answer = await new Promise<boolean | "timeout" | "stopped">((resolve) => {
          running.consent = { by: consentRule.by, resolve };
          const t = setTimeout(() => resolve("timeout"), consentRule.seconds * 1000);
          running.controller.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve("stopped");
          });
        });
        running.consent = undefined;
        if (answer === "timeout") return this.#finishRunning(running, { end: "cancelled", reason: { code: "deadline", text: "nobody agreed in time" } });
        if (answer === "stopped") return this.#finishStopped(running, []);
        if (!answer) return this.#finishRunning(running, { end: "refused", reason: { code: "forbidden", text: "consent was refused" } });
      }
      this.#intermediate(running, { type: "accepted", id: msg.id, seq: actEntry.seq }, true);
      await this.#runLaw(running, () => run(ctx));
    })();
  }

  #onEdit(presence: Presence, msg: Edit): void {
    const key = reqKey(presence, msg.id);
    const [editEntry] = this.#append([
      {
        source: `presence/${presence.id}`,
        type: "asp.edit",
        data: stripUndefined({ presence: presence.id, id: msg.id, changes: msg.changes as unknown as JSONValue, sentence: msg.sentence, basis: msg.basis }) as JSONValue,
      },
    ]);
    const stored: StoredRequest = { key, type: "edit", state: "running", act: editEntry.seq, presence: presence.id, request: msg as unknown as Record<string, unknown> };
    this.store.putRequest(stored);
    const refuse = (code: string, text: string) => this.#finishRecorded(presence, stored, msg.id, editEntry.seq, [], { end: "refused", reason: { code, text } });
    const cap = this.capabilities.edit ?? {};
    const role = this.#roles()[presence.role] ?? {};
    if (!role.edit || (cap.roles && !cap.roles.includes(presence.role))) return refuse("forbidden", `role ${presence.role} may not edit`);
    if (!msg.changes && msg.sentence === undefined) return refuse("malformed", "an edit needs changes or a sentence");
    if (msg.sentence !== undefined && !cap.sentences) return refuse("unsupported", "edits by sentence are not taken");
    const kinds = cap.changes;
    const bad = kinds && msg.changes?.find((c) => !kinds.includes(c.op));
    if (bad) return refuse("unsupported", `changes of kind ${bad.op} are not taken`);
    if (msg.basis !== undefined && msg.basis > this.store.head()) return refuse("malformed", `basis ${msg.basis} is beyond the head of the record`);
    const touched = (msg.changes ?? []).flatMap((c: any) => (c.op === "add" ? [c.thing.id] : c.relation ? [c.relation.from, c.relation.to] : [c.thing]));
    const stale = this.#isStale(touched, msg.basis);
    if (stale) return refuse("stale", stale);
    if (!this.#h.edit) return refuse("unsupported", "this space takes no edits");
    const running = this.#startRunning(presence, "edit", msg.id, stored, editEntry.seq, msg.deadline);
    const ctx = this.#context(running) as EditContext;
    Object.assign(ctx, { changes: msg.changes, sentence: msg.sentence, basis: msg.basis });
    running.settled = (async () => {
      this.#intermediate(running, { type: "accepted", id: msg.id, seq: editEntry.seq }, true);
      await this.#runLaw(running, () => this.#h.edit!(ctx));
    })();
  }

  #onStream(presence: Presence, msg: Record<string, any>): void {
    const form = this.vocabulary.forms?.[msg.form];
    const stored: StoredRequest = { key: reqKey(presence, msg.id), type: "stream", state: "running", presence: presence.id };
    if (!form?.continuous || !(this.capabilities.forms ?? []).includes(msg.form) || !this.#h.stream) {
      return this.#finishSimple(presence, msg, { end: "refused", reason: { code: "unsupported", text: `${msg.form} is not a declared continuous form` } });
    }
    this.store.putRequest(stored);
    const running = this.#startRunning(presence, "stream", msg.id, stored, undefined, undefined);
    let n = 0;
    const ctx = this.#context(running) as StreamContext;
    Object.assign(ctx, {
      form: msg.form,
      rate: msg.rate,
      frame: (content: FormContent) => {
        if (running.finished) return;
        presence.session?.conn.send({ type: "frame", stream: msg.id, n: n++, time: now(), content });
      },
    });
    running.settled = (async () => {
      this.#intermediate(running, { type: "accepted", id: msg.id }, true);
      await this.#runLaw(running, () => this.#h.stream!(ctx).then(() => ({ result: { frames: n } })));
    })();
  }

  #startRunning(presence: Presence, type: Running["type"], id: string, stored: StoredRequest, actSeq: number | undefined, deadline: number | undefined): Running {
    const running: Running = {
      key: stored.key,
      id,
      type,
      presence,
      actSeq,
      controller: new AbortController(),
      paused: false,
      resumeWaiters: [],
      events: [],
      stored,
      finished: false,
      settled: Promise.resolve(),
    };
    this.#running.set(running.key, running);
    if (deadline !== undefined) {
      running.deadline = setTimeout(() => this.#stop(running, "deadline"), deadline * 1000);
    }
    return running;
  }

  #context(running: Running): RequestContext {
    const self = this;
    const ctx: RequestContext = {
      id: running.id,
      presence: presenceInfo(running.presence),
      actSeq: running.actSeq,
      signal: running.controller.signal,
      get stopReason() {
        return running.stopReason;
      },
      progress(progress?: number, text?: string) {
        if (running.finished) return;
        self.#intermediate(running, stripUndefined({ type: "progress", id: running.id, progress, text }) as Record<string, unknown>, false);
      },
      emit(kind: string, data?: JSONValue, options: EmitOptions = {}) {
        if (running.finished) return;
        running.events.push({
          source: `presence/${running.presence.id}`,
          type: kind,
          cause: running.actSeq,
          ...(data !== undefined ? { data } : {}),
          ...(options.things ? { things: options.things } : {}),
          ...(options.roles ? { roles: options.roles } : {}),
        });
      },
      async checkpoint() {
        while (running.paused && !running.controller.signal.aborted) await new Promise<void>((r) => running.resumeWaiters.push(r));
        if (running.controller.signal.aborted) throw new Stopped();
      },
      async sleep(ms: number) {
        let left = ms;
        while (left > 0) {
          await ctx.checkpoint();
          const start = Date.now();
          const step = Math.min(left, 50);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, step);
            running.controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
          if (!running.paused) left -= Date.now() - start;
        }
        await ctx.checkpoint();
      },
    };
    return ctx;
  }

  /** Sends an intermediate state, remembering it for a repeated ID. */
  #intermediate(running: Running, message: Record<string, unknown>, persist: boolean): void {
    if (running.finished) return;
    running.stored.last = message;
    if (persist) this.store.putRequest(running.stored);
    running.presence.session?.conn.send(message);
  }

  /** Runs a law and turns how it ended into exactly one final outcome. */
  async #runLaw(running: Running, law: () => unknown): Promise<void> {
    let grace: NodeJS.Timeout | undefined;
    const graceMs = this.#opts.stopGraceMs ?? 2000;
    const onAbort = () => {
      grace = setTimeout(() => {
        if (running.finished) return;
        const why = running.stopReason === "cancel" ? "cancelled" : (running.stopReason ?? "closed");
        this.#finishRunning(running, {
          end: "unknown",
          reason: { code: running.stopReason === "cancel" ? "sdk.not_stopped" : (running.stopReason ?? "closed"), text: `could not confirm that it stopped after it was ${why === "deadline" ? "past its deadline" : why}` },
          known: { asked_to_stop: true },
          unconfirmed: ["stopped"],
        });
      }, graceMs);
    };
    running.controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const value = (await law()) as ActResult | void;
      if (running.finished) return;
      this.#finishRunning(running, { end: "done", ...(value?.result !== undefined ? { result: value.result } : {}) }, value?.things);
    } catch (e) {
      if (running.finished) return;
      if (e instanceof Refused) {
        running.events = [];
        this.#finishRunning(running, { end: "refused", reason: reasonOf(e.code, e.text, e.data) });
      } else if (e instanceof Failed) {
        this.#finishRunning(running, { end: "failed", reason: reasonOf(e.code, e.text, e.data), effects: e.effects });
      } else if (e instanceof Uncertain) {
        this.#finishRunning(running, { end: "unknown", reason: { code: e.code, text: e.text }, known: e.known, unconfirmed: e.unconfirmed, ...(e.effects.length ? { effects: e.effects } : {}) });
      } else if (e instanceof Stopped || running.controller.signal.aborted) {
        this.#finishStopped(running, e instanceof Stopped ? e.effects : []);
      } else {
        console.error("asp space: a law threw:", e);
        this.#finishRunning(running, {
          end: "unknown",
          reason: { code: "sdk.exception", text: e instanceof Error ? e.message : String(e) },
          known: {},
          unconfirmed: ["effects"],
        });
      }
    } finally {
      if (grace) clearTimeout(grace);
    }
  }

  #finishStopped(running: Running, effects: Effect[]): void {
    switch (running.stopReason) {
      case "deadline":
        return this.#finishRunning(running, { end: "failed", reason: { code: "deadline", text: "stopped at its deadline" }, effects });
      case "closed":
        return this.#finishRunning(running, { end: "cancelled", reason: { code: "closed", text: "the space closed" }, effects });
      default:
        return this.#finishRunning(running, { end: "cancelled", effects });
    }
  }

  #finishRunning(running: Running, outcome: OutcomeFields, things?: string[]): void {
    if (running.finished) return;
    running.finished = true;
    if (running.deadline) clearTimeout(running.deadline);
    this.#running.delete(running.key);
    for (const w of running.resumeWaiters) w();
    const events = outcome.end === "refused" ? [] : running.events;
    if (running.type === "stream") {
      const final = { type: "outcome", id: running.id, ...outcome };
      running.stored.state = "final";
      running.stored.final = final;
      this.store.putRequest(running.stored);
      running.presence.session?.conn.send(final);
      return;
    }
    this.#finishRecorded(running.presence, running.stored, running.id, running.actSeq, events, outcome, things);
  }

  /** Appends the events and the outcome in one commit, remembers the final answer and sends it. */
  #finishRecorded(presence: Presence, stored: StoredRequest, id: string, actSeq: number | undefined, events: NewEntry[], outcome: OutcomeFields, things?: string[]): void {
    let final!: Record<string, unknown>;
    this.store.transaction(() => {
      const evs = this.store.append(events);
      const eventSeqs = evs.map((e) => e.seq);
      const data = stripUndefined({ presence: presence.id, id, ...outcome, ...(eventSeqs.length ? { events: eventSeqs } : {}) });
      const [entry] = this.store.append([
        { source: "space", type: "asp.outcome", ...(actSeq !== undefined ? { cause: actSeq } : {}), ...(things?.length ? { things } : {}), data: data as JSONValue },
      ]);
      final = stripUndefined({ type: "outcome", id, ...outcome, seq: entry.seq, ...(eventSeqs.length ? { events: eventSeqs } : {}) });
      stored.state = "final";
      stored.final = final;
      stored.last = undefined;
      this.store.putRequest(stored);
      for (const e of [...evs, entry]) this.#noteChanges(e);
    });
    presence.session?.conn.send(final);
    for (const p of this.#presences.values()) this.#pump(p);
  }

  /** Answers a request that is not recorded as an action, remembering it when its ID must not run twice. */
  #finishSimple(presence: Presence, msg: Record<string, any>, outcome: OutcomeFields, remember = true, seq?: number): void {
    const final = stripUndefined({ type: "outcome", id: msg.id, ...outcome, ...(seq !== undefined ? { seq } : {}) });
    if (remember && IDEMPOTENT.has(msg.type)) this.store.putRequest({ key: reqKey(presence, msg.id), type: msg.type, state: "final", presence: presence.id, final });
    presence.session?.conn.send(final);
  }

  #stop(running: Running, reason: "cancel" | "deadline" | "closed"): void {
    if (running.finished || running.controller.signal.aborted) return;
    running.stopReason = reason;
    running.controller.abort(new Stopped());
    for (const w of running.resumeWaiters) w();
  }

  #onCancel(presence: Presence, msg: { action: string }): void {
    const key = reqKey(presence, msg.action);
    const running = this.#running.get(key);
    if (!running) {
      if (!this.store.getRequest(key)) this.#error(presence.session!, "malformed", `no request ${msg.action} to cancel`, "cancel");
      return;
    }
    if (running.actSeq !== undefined) {
      this.#append([{ source: `presence/${presence.id}`, type: "asp.cancel", cause: running.actSeq, data: { presence: presence.id, id: msg.action } }]);
    }
    this.#stop(running, "cancel");
  }

  /* ───────────────────────────── Capabilities ───────────────────────────── */

  #onConsent(presence: Presence, msg: { id: string; act: number; agree: boolean }): void {
    const running = [...this.#running.values()].find((r) => r.actSeq === msg.act && r.consent);
    if (!running) return this.#finishSimple(presence, msg as any, { end: "refused", reason: { code: "malformed", text: `no action waits for consent at ${msg.act}` } });
    const role = this.#roles()[presence.role] ?? {};
    if (!role.consent || presence.role !== running.consent!.by) {
      return this.#finishSimple(presence, msg as any, { end: "refused", reason: { code: "forbidden", text: `role ${presence.role} may not consent to this` } });
    }
    const [entry] = this.#append([{ source: `presence/${presence.id}`, type: "asp.consent", cause: msg.act, data: { presence: presence.id, act: msg.act, agree: msg.agree } }]);
    running.consent!.resolve(msg.agree);
    this.#finishSimple(presence, msg as any, { end: "done" }, true, entry.seq);
  }

  #onSnapshot(presence: Presence, msg: Record<string, any>): void {
    try {
      if (msg.type === "snapshot") {
        if (!this.#h.snapshot) throw new Refused("unsupported", "this space cannot save");
        const value = this.#h.snapshot();
        const hash = this.putBlob(canonicalJson(value), "application/json");
        const [entry] = this.#append([{ source: `presence/${presence.id}`, type: "asp.snapshot", data: { presence: presence.id, snapshot: hash } }]);
        return this.#finishSimple(presence, msg, { end: "done", result: { snapshot: hash } }, true, entry.seq);
      }
      if (!this.capabilities.snapshot?.restore || !this.#h.restore) throw new Refused("unsupported", "this space cannot restore");
      const blob = this.#blobs.get(msg.snapshot);
      if (!blob) throw new Refused("expired", "no save with that hash is kept");
      this.#h.restore(JSON.parse(blob.data.toString("utf8")));
      const [entry] = this.#append([{ source: `presence/${presence.id}`, type: "asp.restore", data: { presence: presence.id, snapshot: msg.snapshot } }]);
      this.#finishSimple(presence, msg, { end: "done" }, true, entry.seq);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      this.#finishSimple(presence, msg, { end: "refused", reason: reasonOf(e.code, e.text, e.data) });
    }
  }

  #onEpisode(presence: Presence, msg: Record<string, any>): void {
    const info = presenceInfo(presence);
    try {
      if (msg.type === "episode") {
        if (!this.#h.episode) throw new Refused("unsupported", "this space has no episodes");
        const result = this.#h.episode({ task: msg.task, seed: msg.seed, presence: info });
        const [entry] = this.#append([{ source: `presence/${presence.id}`, type: "asp.episode", data: stripUndefined({ episode: result.episode, task: msg.task, seed: msg.seed }) }]);
        return this.#finishSimple(presence, msg, { end: "done", result }, true, entry.seq);
      }
      const evaluator = this.capabilities.episode?.evaluator ?? "evaluator";
      if (presence.role !== evaluator) throw new Refused("forbidden", `only the ${evaluator} role receives scores`);
      if (!this.#h.score) throw new Refused("unsupported", "this space gives no scores");
      const score = this.#h.score({ episode: msg.episode, presence: info });
      const [entry] = this.#append([{ source: "space", type: "asp.score", roles: [evaluator], data: { episode: score.episode, score: score.score } }]);
      this.#finishSimple(presence, msg, { end: "done", result: score as unknown as JSONValue }, false, entry.seq);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      this.#finishSimple(presence, msg, { end: "refused", reason: reasonOf(e.code, e.text, e.data) }, msg.type === "episode");
    }
  }

  #onPause(presence: Presence, msg: Record<string, any>): void {
    const running = this.#running.get(reqKey(presence, msg.action));
    if (!running) return this.#finishSimple(presence, msg, { end: "refused", reason: { code: "malformed", text: `no action ${msg.action} under way` } });
    const verbs = this.capabilities.pause?.verbs;
    if (verbs && running.verb && !verbs.includes(running.verb)) {
      return this.#finishSimple(presence, msg, { end: "refused", reason: { code: "unsupported", text: `${running.verb} cannot be paused` } });
    }
    if (msg.type === "pause") running.paused = true;
    else {
      running.paused = false;
      const waiters = running.resumeWaiters;
      running.resumeWaiters = [];
      for (const w of waiters) w();
    }
    this.#finishSimple(presence, msg, { end: "done", result: { paused: running.paused } });
  }

  #onSense(presence: Presence, msg: Record<string, any>): void {
    const cap = this.capabilities.senses ?? {};
    const refuse = (code: string, text: string) => this.#finishSimple(presence, msg, { end: "refused", reason: { code, text } });
    if (msg.op === "list") {
      return this.#finishSimple(presence, msg, {
        end: "done",
        result: { senses: [...presence.senses].map(([name, s]) => ({ name, language: s.language, query: s.query })) },
      });
    }
    if (!msg.name) return refuse("malformed", "a sense needs a name");
    if (msg.op === "remove") {
      if (!presence.senses.delete(msg.name)) return refuse("malformed", `no sense named ${msg.name}`);
      return this.#finishSimple(presence, msg, { end: "done" });
    }
    if (!msg.language || msg.query === undefined) return refuse("malformed", "placing a sense needs a language and a query");
    if (cap.languages && !cap.languages.includes(msg.language)) return refuse("unsupported", `language ${msg.language} is not declared`);
    if (cap.max !== undefined && presence.senses.size >= cap.max && !presence.senses.has(msg.name)) return refuse("forbidden", "too many senses");
    presence.senses.set(msg.name, { language: msg.language, query: msg.query });
    this.#finishSimple(presence, msg, { end: "done", result: { name: msg.name } });
  }

  #onOffer(presence: Presence, msg: Record<string, any>): void {
    const doors = this.capabilities.doors ?? {};
    const refuse = (code: string, text: string) => this.#finishSimple(presence, msg, { end: "refused", reason: { code, text } });
    if (!msg.thing) {
      const door = doors.doors?.find((d) => d.thing === msg.door);
      if (!door) return refuse("malformed", `no door ${msg.door}`);
      if (!presence.participant?.startsWith("ed25519:")) return refuse("forbidden", "only a participant with a key can pass through a door");
      const pass = makePass(this.key, {
        participant: presence.participant,
        from: this.key.identity,
        to: door.to,
        door: door.thing,
        expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      this.#finishSimple(presence, msg, { end: "done", result: { to: door.to, pass } });
      const entry = this.#endPresence(presence, "door");
      void entry;
      if (presence.session) presence.session.presence = undefined;
      presence.session = undefined;
      return;
    }
    if (!doors.takes || !this.#h.take) return refuse("unsupported", "this space does not take things");
    const thing = msg.thing as OfferedThing;
    const known = this.vocabulary.types ?? {};
    const as = [thing.type, ...(thing.parents ?? [])].find((t) => known[t]);
    if (!as) return refuse("unsupported", `no type of ${thing.id} is known here`);
    let taken: { thing: string };
    try {
      taken = this.#h.take({ thing, as, from: presence.participant, door: msg.door });
    } catch (e) {
      if (e instanceof Refused) return refuse(e.code, e.text ?? e.code);
      throw e;
    }
    const [entry] = this.#append([
      { source: `presence/${presence.id}`, type: "asp.take", things: [taken.thing], data: { offer: msg.id, from: presence.participant ?? null, thing: taken.thing, as } },
    ]);
    this.#finishSimple(presence, msg, { end: "done", result: { thing: taken.thing, as, take: entry.seq } }, true, entry.seq);
  }

  async #onTake(presence: Presence, msg: Record<string, any>): Promise<void> {
    const key = reqKey(presence, msg.offer);
    const stored = this.store.getRequest(key);
    if (!stored) {
      // Without a recorded take the thing still belongs to the giving side; never take this offer later.
      this.store.putRequest({
        key,
        type: "offer",
        state: "final",
        presence: presence.id,
        final: { type: "outcome", id: msg.offer, end: "refused", reason: { code: "closed", text: "the offer was asked about before it arrived" } },
      });
      return this.#finishSimple(presence, msg, { end: "done", result: { taken: false } }, false);
    }
    const final = stored.final as any;
    const taken = final?.end === "done";
    this.#finishSimple(presence, msg, { end: "done", result: taken ? { taken, take: final.result.take, thing: final.result.thing } : { taken: false } }, false);
  }

  /* ───────────────────────────── Restarts ───────────────────────────── */

  #recover(): void {
    const running = this.store.runningRequests();
    if (this.store.head() === 0 && !running.length) return;
    this.#append([{ source: "space", type: "asp.restarted" }]);
    for (const r of running) {
      const outcome: OutcomeFields = {
        end: "unknown",
        reason: { code: "restarted", text: "the space restarted while it was under way" },
        known: { taken: true },
        unconfirmed: ["finished"],
      };
      if (r.type === "act" || r.type === "edit") {
        const presenceId = r.presence ?? "";
        const fake = { id: presenceId } as Presence;
        this.#finishRecorded(fake, r, r.key.slice(r.key.indexOf("\n") + 1), r.act, [], outcome);
      } else {
        r.state = "final";
        r.final = { type: "outcome", id: r.key.slice(r.key.indexOf("\n") + 1), ...outcome };
        this.store.putRequest(r);
      }
    }
  }
}

type OutcomeFields = {
  end: "done" | "refused" | "failed" | "cancelled" | "unknown";
  reason?: Reason;
  result?: JSONValue;
  effects?: Effect[];
  known?: Record<string, JSONValue>;
  unconfirmed?: string[];
};

function reqKey(presence: Presence, id: string): string {
  return `${presence.key}\n${id}`;
}

function presenceInfo(p: Presence): PresenceInfo {
  return { id: p.id, role: p.role, ...(p.participant ? { participant: p.participant } : {}) };
}

function reasonOf(code: string, text?: string, data?: JSONValue): Reason {
  return stripUndefined({ code, text, data }) as Reason;
}

function stripProps<T extends Record<string, unknown>>(obj: T, hide: string[]): T {
  if (!hide.length) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!hide.includes(k) || k === "id" || k === "type") out[k] = v;
  return out as T;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** The parts a space supports by default: the core, and the part of every declared capability. */
export function defaultParts(capabilities: Capabilities): SupportedParts {
  const parts: SupportedParts = { core: [0] };
  for (const part of CAPABILITY_PARTS) if ((capabilities as Record<string, unknown>)[part] !== undefined) parts[part] = [0];
  return parts;
}
