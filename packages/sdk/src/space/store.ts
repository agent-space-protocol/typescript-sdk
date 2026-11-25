/**
 * Where a space keeps its record and the requests it remembers: in memory, or in SQLite on disk
 * so that the record and the IDs survive a restart.
 */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry, JSONValue } from "../types/index.ts";

/** An entry before it is appended: the store gives it `seq` and `id`. */
export interface NewEntry {
  source: string;
  type: string;
  time?: string;
  cause?: number;
  things?: string[];
  roles?: string[];
  datacontenttype?: string;
  data?: JSONValue;
  dataref?: string;
}

/** A request the space remembers, so that an ID sent again is never carried out twice. */
export interface StoredRequest {
  /** The participant's key and the request ID, joined by a newline. */
  key: string;
  /** The message type of the request. */
  type: string;
  /** Whether it is still under way. */
  state: "running" | "final";
  /** The sequence number of its `asp.act` or `asp.edit` entry. */
  act?: number;
  /** The presence that sent it. */
  presence?: string;
  /** The last intermediate message sent for it. */
  last?: Record<string, unknown>;
  /** Its final answer. */
  final?: Record<string, unknown>;
  /** What the request was, for spaces that need it after a restart. */
  request?: Record<string, unknown>;
}

/** A range of the record. */
export interface ReadRange {
  from?: number;
  to?: number;
  since?: string;
  until?: string;
  limit?: number;
}

/** The storage of a space. All methods are synchronous, so appending and delivering never interleave. */
export interface Store {
  /** Appends entries in one transaction and returns them with their sequence numbers. */
  append(entries: NewEntry[]): Entry[];
  /** Reads entries in order. */
  read(range: ReadRange): Entry[];
  /** The latest sequence number, 0 when empty. */
  head(): number;
  /** The earliest sequence number kept. */
  earliest(): number;
  /** Removes entries appended before a time, and the requests answered by them. */
  prune(before: string): void;
  getRequest(key: string): StoredRequest | undefined;
  putRequest(request: StoredRequest): void;
  /** Requests still under way, for recovery after a restart. */
  runningRequests(): StoredRequest[];
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  /** Runs a function in one transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

function complete(e: NewEntry, seq: number): Entry {
  const entry: Entry = {
    specversion: "1.0",
    id: String(seq),
    source: e.source,
    type: e.type,
    time: e.time ?? new Date().toISOString(),
    seq,
    aspcore: 0,
  };
  for (const [k, v] of Object.entries(e)) if (v !== undefined && !(k in entry)) (entry as any)[k] = v;
  return entry;
}

function inRange(e: Entry, r: ReadRange): boolean {
  if (r.from !== undefined && e.seq < r.from) return false;
  if (r.to !== undefined && e.seq > r.to) return false;
  if (r.since !== undefined && e.time < r.since) return false;
  if (r.until !== undefined && e.time >= r.until) return false;
  return true;
}

/** A store in memory: lost when the process ends. */
export class MemoryStore implements Store {
  #entries: Entry[] = [];
  #head = 0;
  #earliest = 1;
  #requests = new Map<string, StoredRequest>();
  #meta = new Map<string, string>();

  append(entries: NewEntry[]): Entry[] {
    const out = entries.map((e) => complete(e, ++this.#head));
    this.#entries.push(...out);
    return out;
  }
  read(range: ReadRange): Entry[] {
    const out: Entry[] = [];
    for (const e of this.#entries) {
      if (range.to !== undefined && e.seq > range.to) break;
      if (inRange(e, range)) {
        out.push(e);
        if (range.limit && out.length >= range.limit) break;
      }
    }
    return out;
  }
  head(): number {
    return this.#head;
  }
  earliest(): number {
    return this.#earliest;
  }
  prune(before: string): void {
    const i = this.#entries.findIndex((e) => e.time >= before);
    const cut = i < 0 ? this.#entries.length : i;
    if (cut === 0) return;
    this.#entries.splice(0, cut);
    this.#earliest = this.#entries.length ? this.#entries[0].seq : this.#head + 1;
  }
  getRequest(key: string) {
    return this.#requests.get(key);
  }
  putRequest(request: StoredRequest): void {
    this.#requests.set(request.key, request);
  }
  runningRequests(): StoredRequest[] {
    return [...this.#requests.values()].filter((r) => r.state === "running");
  }
  getMeta(key: string) {
    return this.#meta.get(key);
  }
  setMeta(key: string, value: string): void {
    this.#meta.set(key, value);
  }
  transaction<T>(fn: () => T): T {
    return fn();
  }
  close(): void {}
}

/** Loads `node:sqlite` without its experimental-feature warning on stderr. */
function loadSqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

/** A store in one SQLite file, kept across restarts. Uses Node's built-in `node:sqlite`. */
export class SqliteStore implements Store {
  #db: DatabaseSync;
  #head: number;
  #earliest: number;
  #depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new (loadSqlite().DatabaseSync)(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, time TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_time ON entries (time);
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.#head = Number((this.#db.prepare("SELECT MAX(seq) AS m FROM entries").get() as any).m ?? 0);
    const storedHead = Number(this.getMeta("head") ?? 0);
    if (storedHead > this.#head) this.#head = storedHead;
    this.#earliest = Number(this.getMeta("earliest") ?? 1);
  }

  append(entries: NewEntry[]): Entry[] {
    return this.transaction(() => {
      const insert = this.#db.prepare("INSERT INTO entries (seq, time, json) VALUES (?, ?, ?)");
      const out = entries.map((e) => {
        const entry = complete(e, ++this.#head);
        insert.run(entry.seq, entry.time, JSON.stringify(entry));
        return entry;
      });
      this.setMeta("head", String(this.#head));
      return out;
    });
  }
  read(range: ReadRange): Entry[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (range.from !== undefined) (where.push("seq >= ?"), args.push(range.from));
    if (range.to !== undefined) (where.push("seq <= ?"), args.push(range.to));
    if (range.since !== undefined) (where.push("time >= ?"), args.push(range.since));
    if (range.until !== undefined) (where.push("time < ?"), args.push(range.until));
    const sql =
      "SELECT json FROM entries" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY seq" + (range.limit ? ` LIMIT ${Math.floor(range.limit)}` : "");
    return (this.#db.prepare(sql).all(...args) as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  head(): number {
    return this.#head;
  }
  earliest(): number {
    return this.#earliest;
  }
  prune(before: string): void {
    this.transaction(() => {
      this.#db.prepare("DELETE FROM entries WHERE time < ?").run(before);
      const min = (this.#db.prepare("SELECT MIN(seq) AS m FROM entries").get() as any).m;
      const earliest = min == null ? this.#head + 1 : Number(min);
      if (earliest !== this.#earliest) {
        this.#earliest = earliest;
        this.setMeta("earliest", String(earliest));
      }
    });
  }
  getRequest(key: string): StoredRequest | undefined {
    const row = this.#db.prepare("SELECT json FROM requests WHERE key = ?").get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  putRequest(request: StoredRequest): void {
    this.#db
      .prepare("INSERT INTO requests (key, state, json) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, json = excluded.json")
      .run(request.key, request.state, JSON.stringify(request));
  }
  runningRequests(): StoredRequest[] {
    return (this.#db.prepare("SELECT json FROM requests WHERE state = 'running'").all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    const head = this.#head;
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      this.#head = head;
      throw e;
    } finally {
      this.#depth--;
    }
  }
  close(): void {
    this.#db.close();
  }
}
