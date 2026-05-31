// Minimal, dependency-free JSON-RPC client for `codex app-server`, in plain ESM.
// Transport is newline-delimited JSON over the child's stdio. The connection is
// bidirectional: the server also
// sends us *requests* (approvals, dynamic-tool calls) that we must answer.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const READY_TIMEOUT_MS = 15_000;

export class AppServerClient extends EventEmitter {
  #child;
  #stdoutBuffer = "";
  #stderrTail = "";
  #nextId = 1;
  #pending = new Map();
  #state = "disconnected";
  #generation = 0;

  constructor(options = {}) {
    super();
    this.setMaxListeners(0); // many concurrent agents attach notification listeners
    this.options = options; // { cwd, command, args, clientInfo, capabilities, requestHandler }
  }

  get readyState() {
    return this.#state;
  }

  get recentStderr() {
    return this.#stderrTail.slice(-4_000);
  }

  async connect() {
    if (this.#state === "ready") return;
    if (this.#state === "connecting") return this.#waitUntilReady();

    this.#generation += 1;
    const generation = this.#generation;
    this.#state = "connecting";

    const command = this.options.command ?? "codex";
    const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
    const cwd = this.options.cwd ?? process.cwd();

    this.#child = spawn(command, args, {
      cwd,
      env: sanitizeEnv(process.env, cwd),
      stdio: "pipe",
    });

    this.#child.stdout.on("data", (chunk) => {
      if (generation !== this.#generation) return;
      this.#acceptStdout(chunk.toString("utf8"));
    });
    this.#child.stderr.on("data", (chunk) => {
      if (generation !== this.#generation) return;
      this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-12_000);
    });
    this.#child.on("exit", (code, signal) => {
      if (generation !== this.#generation) return;
      this.#closePending(new Error(`app-server exited code=${code} signal=${signal}`));
      this.#state = "disconnected";
      this.emit("transport", { stage: "exit", code, signal });
    });
    this.#child.on("error", (err) => {
      this.#closePending(err);
      this.#state = "disconnected";
      this.emit("transport", { stage: "error", error: err });
    });

    await this.request(
      "initialize",
      {
        clientInfo: this.options.clientInfo ?? {
          name: "codex-workflows",
          title: "Codex Workflows Runner",
          version: "0.1.0",
        },
        capabilities: this.options.capabilities ?? { experimentalApi: true },
      },
      READY_TIMEOUT_MS,
    );
    this.notify("initialized");
    this.#state = "ready";
    this.emit("transport", { stage: "ready" });
  }

  async shutdown() {
    this.#generation += 1;
    this.#closePending(new Error("client shut down"));
    this.#state = "disconnected";
    try {
      this.#child?.stdin.end();
    } catch {}
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
  }

  request(method, params, timeoutMs = 60_000) {
    if (!this.#child || !this.#child.stdin.writable) {
      return Promise.reject(new Error("Transport is not connected"));
    }
    const id = this.#nextId++;
    const frame = { id, method };
    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Request timed out: ${method}; stderr=${this.recentStderr}`));
      }, timeoutMs);

      this.#pending.set(id, { method, resolve, reject, timeout });
      this.#child.stdin.write(JSON.stringify(frame) + "\n", (err) => {
        if (!err) return;
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  notify(method, params) {
    if (!this.#child || !this.#child.stdin.writable) {
      throw new Error("Transport is not connected");
    }
    const frame = { method };
    if (params !== undefined) frame.params = params;
    this.#child.stdin.write(JSON.stringify(frame) + "\n");
  }

  async listModels() {
    const r = await this.request("model/list", { limit: 200, includeHidden: true });
    return r?.data ?? [];
  }

  startThread(params) {
    return this.request("thread/start", params, 60_000);
  }

  startTurn(params) {
    return this.request("turn/start", params, 60_000);
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId }, 15_000);
  }

  waitForNotification(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for app-server notification"));
      }, timeoutMs);
      const listener = (n) => {
        if (!predicate(n)) return;
        cleanup();
        resolve(n);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("notification", listener);
      };
      this.on("notification", listener);
    });
  }

  #acceptStdout(text) {
    this.#stdoutBuffer += text;
    let idx;
    while ((idx = this.#stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuffer.slice(0, idx).replace(/\r$/, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(idx + 1);
      if (line.trim()) this.#handleFrame(line);
    }
  }

  #handleFrame(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // Non-JSON line (e.g., a startup log on stdout) — ignore and keep going.
      this.emit("protocolError", { line });
      return;
    }
    if ("method" in frame && "id" in frame) {
      void this.#handleServerRequest(frame);
      return;
    }
    if ("method" in frame) {
      this.emit("notification", { method: frame.method, params: frame.params });
      return;
    }
    if ("id" in frame) {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timeout);
      if (frame.error) {
        pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(frame.error)}`));
      } else {
        pending.resolve(frame.result);
      }
    }
  }

  async #handleServerRequest(req) {
    let payload;
    try {
      const result = this.options.requestHandler
        ? await this.options.requestHandler(req)
        : defaultServerResponse(req);
      payload = { id: req.id, result };
    } catch (e) {
      payload = { id: req.id, error: { code: -32603, message: e?.message ?? String(e) } };
    }
    try {
      this.#child?.stdin.write(JSON.stringify(payload) + "\n");
    } catch {}
  }

  async #waitUntilReady() {
    for (let i = 0; i < 300; i++) {
      if (this.#state === "ready") return;
      await delay(50);
    }
    throw new Error("Timed out waiting for app-server ready state");
  }

  #closePending(err) {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timeout);
      p.reject(err);
    }
    this.#pending.clear();
  }
}

// With approvalPolicy:"never" the server should not prompt, but answer defensively
// so a stray approval request can never deadlock a turn.
function defaultServerResponse(req) {
  if (req.method === "item/tool/call") {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: "No dynamic tool handler is registered." }],
    };
  }
  return { decision: "accept" };
}

function sanitizeEnv(env, cwd) {
  const next = { ...env, PWD: cwd };
  for (const k of Object.keys(next)) {
    if (k === "DYLD_INSERT_LIBRARIES" || k === "DYLD_LIBRARY_PATH" || k === "DYLD_FRAMEWORK_PATH") {
      delete next[k];
    }
  }
  return next;
}
