import { randomUUID } from "node:crypto";
import type { CodexController, RpcEvent } from "../app/types.js";
export class MockCodex implements CodexController {
  connectionId = randomUUID();
  connected = false;
  calls: { method: string; params: any }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  threads = new Map<string, any>();
  projects = new Map<string, any>();
  private projectKeys = new Map<string, string>();
  private handlers: ((e: RpcEvent) => void)[] = [];
  constructor(public autoComplete = false) {}
  onEvent(h: (e: RpcEvent) => void) {
    this.handlers.push(h);
  }
  emit(method: string, params: Record<string, any>, id?: string | number) {
    for (const h of this.handlers)
      h({ method, params, id, connectionId: this.connectionId });
  }
  async connect() {
    this.connected = true;
    this.emit("bridge/connected", {});
  }
  async disconnect() {
    this.connected = false;
    this.emit("bridge/disconnected", {});
  }
  async reconnect() {
    await this.disconnect();
    this.connectionId = randomUUID();
    await this.connect();
  }
  async request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    let result: any = {};
    if (method === "model/list")
      result = {
        data: [
          {
            id: "gpt-6.1-sol",
            model: "gpt-6.1-sol",
            displayName: "GPT-6.1 Sol (MOCK)",
            hidden: false,
          },
        ],
        nextCursor: null,
      };
    if (method === "project/list")
      result = { data: [...this.projects.values()], nextCursor: null };
    if (method === "project/create") {
      const key = String(params.idempotencyKey);
      const id = this.projectKeys.get(key) ?? "mock-project-" + randomUUID();
      this.projectKeys.set(key, id);
      if (!this.projects.has(id))
        this.projects.set(id, {
          id,
          name: params.name,
          roots: params.roots,
          metadata: params.metadata ?? {},
        });
      result = { project: this.projects.get(id) };
    }
    if (method === "account/read")
      result = { account: { type: "mock" }, requiresOpenaiAuth: false };
    if (method === "thread/start" || method === "thread/fork") {
      const id = randomUUID();
      const thread = {
        id,
        cwd: params.cwd,
        projectId: params.projectId ?? null,
        status: { type: "idle" },
        turns: [],
      };
      this.threads.set(id, thread);
      result = { thread, model: params.model ?? "mock" };
    }
    if (method === "thread/resume" || method === "thread/read")
      result = {
        model: params.model ?? "mock",
        thread: this.threads.get(String(params.threadId)) ?? {
          id: params.threadId,
          cwd: params.cwd,
          status: { type: "notLoaded" },
          turns: [],
        },
      };
    if (method === "thread/list")
      result = { data: [...this.threads.values()], nextCursor: null };
    if (method === "thread/resume")
      result.thread = {
        ...result.thread,
        canAcceptDirectInput: result.thread.canAcceptDirectInput ?? true,
      };
    if (method === "thread/turns/list")
      result = {
        data: [
          ...(this.threads.get(String(params.threadId))?.turns ?? []),
        ].reverse(),
        nextCursor: null,
      };
    if (method === "thread/metadata/update") {
      const thread = this.threads.get(String(params.threadId));
      if (thread) thread.projectId = params.projectId;
    }
    if (method === "thread/name/set") {
      const thread = this.threads.get(String(params.threadId));
      if (thread) thread.name = params.name;
    }
    if (method === "turn/start") {
      const id = randomUUID();
      result = { turn: { id, status: "inProgress" } };
      if (this.autoComplete)
        setTimeout(() => {
          this.emit("item/completed", {
            threadId: params.threadId,
            turnId: id,
            item: {
              type: "agentMessage",
              text: (params.outputSchema as any)?.properties?.action
                ? JSON.stringify({
                    action: "answer",
                    computer: null,
                    reply:
                      "[MOCK] 已收到消息。这是模拟回复，没有调用真实模型或执行任务。",
                    projectId: null,
                    taskId: null,
                    todoId: null,
                    approvalId: null,
                    text: null,
                    date: null,
                    repeatMinutes: null,
                    newProject: null,
                    target: null,
                  })
                : "[MOCK] 任务演示完成，未运行真实 Codex。",
            },
          });
          this.emit("turn/completed", {
            threadId: params.threadId,
            turn: { id, status: "completed" },
          });
        }, 200);
    }
    if (method === "turn/interrupt")
      queueMicrotask(() =>
        this.emit("turn/completed", {
          threadId: params.threadId,
          turn: { id: params.turnId, status: "interrupted" },
        }),
      );
    return result as T;
  }
  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
  }
  reject(id: string | number, message: string) {
    this.responses.push({ id, result: { error: message } });
  }
}
