import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { CodexController, RpcEvent } from "../app/types.js";
type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};
export class AppServerClient implements CodexController {
  connectionId = "";
  connected = false;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private handlers: ((event: RpcEvent) => void)[] = [];
  private connecting?: Promise<void>;
  constructor(
    private binary = "codex",
    private args = ["app-server", "--listen", "stdio://"],
    private requestTimeout = 30000,
  ) {}
  onEvent(handler: (event: RpcEvent) => void) {
    this.handlers.push(handler);
  }
  private emit(
    method: string,
    params: Record<string, any>,
    id?: number | string,
  ) {
    for (const h of this.handlers)
      h({ method, params, id, connectionId: this.connectionId });
  }
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async open() {
    this.connectionId = randomUUID();
    const child = spawn(this.binary, this.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", () => {}); // Do not log inherited auth/config or command output.
    child.stdin.on("error", () => this.lost(child));
    child.on("error", () => this.lost(child));
    child.on("exit", () => this.lost(child));
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (child !== this.child) return;
      if (line.length > 8_000_000) {
        this.emit("bridge/protocolError", {});
        return;
      }
      try {
        const m = JSON.parse(line);
        if (typeof m.method === "string") {
          this.emit(m.method, m.params ?? {}, m.id);
        } else if (typeof m.id === "number") {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error
              ? p.reject(
                  new Error(`Codex RPC ${m.error.code}: ${m.error.message}`),
                )
              : p.resolve(m.result);
          }
        }
      } catch {
        this.emit("bridge/protocolError", {});
      }
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "codex_wechat_bridge",
          title: "Codex WeChat Bridge",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: false },
      });
      this.write({ method: "initialized" });
      this.connected = true;
      this.emit("bridge/connected", {});
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }
  private lost(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.connected = false;
    this.child = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Codex 连接中断，执行结果未知"));
    }
    this.pending.clear();
    this.emit("bridge/disconnected", {});
  }
  private write(value: unknown) {
    if (!this.child || !this.child.stdin.writable)
      throw new Error("Codex 未连接");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 响应超时；不得自动重放`));
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  reject(id: number | string, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  async disconnect() {
    const child = this.child;
    this.connected = false;
    this.lines?.close();
    if (child) {
      child.stdin.end();
      child.kill();
      this.lost(child);
    }
  }
  async reconnect() {
    await this.disconnect();
    await this.connect();
  }
}
