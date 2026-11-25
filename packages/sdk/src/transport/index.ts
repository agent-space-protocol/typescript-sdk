/**
 * Transports: WebSocket, HTTP with server-sent events, and standard input and output.
 * Every transport carries whole JSON messages and does not look inside them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { randomToken } from "../util.ts";

/** One connection between a participant and a space. */
export interface Connection {
  /** Sends a message. Messages sent after closing are dropped. */
  send(message: object): void;
  /** Sends raw text as one message, for tests that need malformed input. */
  sendRaw(text: string): void;
  /** Closes the connection. For standard input and output, this ends the space's input. */
  close(): void;
  /** Whether the connection is closed. */
  readonly closed: boolean;
  /** Called with the text of every message received. */
  onmessage?: (text: string) => void;
  /** Called once when the connection closes. */
  onclose?: () => void;
  /** Who is on the other side, for logs. */
  readonly peer: string;
}

/** A base for connections: buffers messages until a handler is set, and closes once. */
export abstract class BaseConnection implements Connection {
  closed = false;
  peer = "";
  #onmessage?: (text: string) => void;
  #onclose?: () => void;
  #pending: string[] = [];
  #closeFired = false;

  abstract sendRaw(text: string): void;
  protected abstract doClose(): void;

  send(message: object): void {
    this.sendRaw(JSON.stringify(message));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.doClose();
    } finally {
      this.fireClose();
    }
  }

  get onmessage() {
    return this.#onmessage;
  }
  set onmessage(fn: ((text: string) => void) | undefined) {
    this.#onmessage = fn;
    if (fn) {
      const pending = this.#pending;
      this.#pending = [];
      for (const text of pending) fn(text);
    }
  }
  get onclose() {
    return this.#onclose;
  }
  set onclose(fn: (() => void) | undefined) {
    this.#onclose = fn;
    if (fn && this.#closeFired) queueMicrotask(fn);
  }

  /** Delivers a received message. */
  protected receive(text: string): void {
    if (this.closed) return;
    if (this.#onmessage) this.#onmessage(text);
    else this.#pending.push(text);
  }

  /** Marks the connection closed from the other side. */
  protected fireClose(): void {
    this.closed = true;
    if (this.#closeFired) return;
    this.#closeFired = true;
    this.#onclose?.();
  }
}

/* ───────────────────────────── WebSocket ───────────────────────────── */

class WebSocketConnection extends BaseConnection {
  #ws: WebSocket;
  constructor(ws: WebSocket, peer: string) {
    super();
    this.#ws = ws;
    this.peer = peer;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.receive(data.toString());
    });
    ws.on("close", () => this.fireClose());
    ws.on("error", () => this.fireClose());
  }
  sendRaw(text: string): void {
    if (this.closed || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(text);
  }
  protected doClose(): void {
    this.#ws.close();
  }
  /** Drops the connection without a closing handshake, as a network failure would. */
  terminate(): void {
    this.#ws.terminate();
    this.fireClose();
  }
}

/* ───────────────────────────── HTTP with SSE ───────────────────────────── */

class SseServerConnection extends BaseConnection {
  #res: ServerResponse;
  #keepAlive: NodeJS.Timeout;
  constructor(res: ServerResponse, peer: string) {
    super();
    this.#res = res;
    this.peer = peer;
    this.#keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    res.on("close", () => {
      clearInterval(this.#keepAlive);
      this.fireClose();
    });
  }
  sendRaw(text: string): void {
    if (this.closed) return;
    this.#res.write(`event: message\ndata: ${text}\n\n`);
  }
  protected doClose(): void {
    clearInterval(this.#keepAlive);
    this.#res.end();
  }
  deliver(text: string): void {
    this.receive(text);
  }
}

class SseClientConnection extends BaseConnection {
  #url: string;
  #session = "";
  #abort = new AbortController();
  #queue: Promise<void> = Promise.resolve();
  constructor(url: string) {
    super();
    this.#url = url;
    this.peer = url;
  }
  async open(): Promise<void> {
    const res = await fetch(this.#url, {
      headers: { Accept: "text/event-stream" },
      signal: this.#abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} opening ${this.#url}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let sessionReady!: () => void;
    const ready = new Promise<void>((r) => (sessionReady = r));
    (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let i: number;
          while ((i = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (!data.length) continue;
            const text = data.join("\n");
            if (event === "session") {
              this.#session = JSON.parse(text).session;
              sessionReady();
            } else this.receive(text);
          }
        }
      } catch {
        /* the stream ended */
      }
      this.fireClose();
    })();
    await ready;
  }
  sendRaw(text: string): void {
    if (this.closed) return;
    // Keep the order of messages: each POST starts after the previous one was taken.
    this.#queue = this.#queue.then(async () => {
      try {
        const res = await fetch(this.#url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "ASP-Session": this.#session },
          body: text,
        });
        if (res.status === 404) this.close();
      } catch {
        this.close();
      }
    });
  }
  protected doClose(): void {
    this.#abort.abort();
  }
}

/* ───────────────────────────── Standard input and output ───────────────────────────── */

class StreamConnection extends BaseConnection {
  #write: (text: string) => void;
  #end: () => void;
  constructor(input: NodeJS.ReadableStream, write: (text: string) => void, end: () => void, peer: string) {
    super();
    this.#write = write;
    this.#end = end;
    this.peer = peer;
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.trim()) this.receive(line);
    });
    rl.on("close", () => this.fireClose());
  }
  sendRaw(text: string): void {
    if (this.closed) return;
    this.#write(text.replace(/\n/g, "\\n") + "\n");
  }
  protected doClose(): void {
    this.#end();
  }
}

/** A connection to a space running as a child process, over its standard input and output. */
export class ProcessConnection extends StreamConnection {
  readonly process: ChildProcess;
  constructor(child: ChildProcess, command: string) {
    super(
      child.stdout!,
      (text) => {
        if (child.stdin?.writable) child.stdin.write(text);
      },
      () => child.stdin?.end(),
      command,
    );
    this.process = child;
    child.on("exit", () => this.fireClose());
  }
}

/* ───────────────────────────── Servers ───────────────────────────── */

/** A running listener. */
export interface Listener {
  /** The address participants connect to, with the real port. */
  address: string;
  close(): Promise<void>;
}

/** Listens at an address (`ws://host:port`, `http://host:port`, or `stdio`) and hands every new connection to `accept`. */
export async function listen(address: string, accept: (conn: Connection) => void): Promise<Listener> {
  if (address === "stdio") return serveStdio(accept);
  const url = new URL(address);
  const host = url.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1";
  const port = Number(url.port || 0);
  if (url.protocol === "ws:") {
    const wss = new WebSocketServer({ host, port, path: url.pathname === "/" ? undefined : url.pathname });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("connection", (ws, req) => accept(new WebSocketConnection(ws, req.socket.remoteAddress ?? "")));
    const real = (wss.address() as { port: number }).port;
    return {
      address: `ws://${url.hostname}:${real}${url.pathname === "/" ? "" : url.pathname}`,
      close: () =>
        new Promise((resolve) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => resolve());
        }),
    };
  }
  if (url.protocol === "http:") {
    const sessions = new Map<string, SseServerConnection>();
    const path = url.pathname;
    const server: HttpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const reqPath = (req.url ?? "/").split("?")[0];
      if (path !== "/" && reqPath !== path) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const session = randomToken(16);
        const conn = new SseServerConnection(res, req.socket.remoteAddress ?? "");
        sessions.set(session, conn);
        res.on("close", () => sessions.delete(session));
        res.write(`event: session\ndata: ${JSON.stringify({ session })}\n\n`);
        accept(conn);
        return;
      }
      if (req.method === "POST") {
        const conn = sessions.get(String(req.headers["asp-session"] ?? ""));
        if (!conn) {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(202).end();
          conn.deliver(Buffer.concat(chunks).toString("utf8"));
        });
        return;
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    const real = (server.address() as { port: number }).port;
    return {
      address: `http://${url.hostname}:${real}${path === "/" ? "" : path}`,
      close: () =>
        new Promise((resolve) => {
          for (const c of sessions.values()) c.close();
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
  throw new Error(`cannot listen at ${address}`);
}

/** Serves one connection over this process's standard input and output. */
export async function serveStdio(accept: (conn: Connection) => void): Promise<Listener> {
  const conn = new StreamConnection(
    process.stdin,
    (text) => process.stdout.write(text),
    () => process.stdout.end(),
    "stdio",
  );
  accept(conn);
  return { address: "stdio", close: async () => conn.close() };
}

/* ───────────────────────────── Clients ───────────────────────────── */

/** Options for connecting. */
export interface ConnectOptions {
  /** For a command address: the working directory. */
  cwd?: string;
  /** For a command address: where the process's standard error goes. Defaults to this process's. */
  stderr?: "inherit" | "ignore" | "pipe";
}

/**
 * Connects to an address: a `ws://` or `wss://` URL, an `http://` or `https://` URL, or a command
 * that starts a space speaking over standard input and output.
 */
export async function connect(address: string, options: ConnectOptions = {}): Promise<Connection> {
  if (/^wss?:\/\//.test(address)) {
    const ws = new WebSocket(address);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new WebSocketConnection(ws, address);
  }
  if (/^https?:\/\//.test(address)) {
    const conn = new SseClientConnection(address);
    await conn.open();
    return conn;
  }
  const child = spawn(address, {
    shell: true,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
    windowsHide: true,
  });
  return new ProcessConnection(child, address);
}

/** Drops a connection without closing it cleanly, as a network failure would. For tests. */
export function dropConnection(conn: Connection): void {
  if (conn instanceof WebSocketConnection) conn.terminate();
  else conn.close();
}
