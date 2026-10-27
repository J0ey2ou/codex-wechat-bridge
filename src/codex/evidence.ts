import type { CodexController, RpcEvent } from "../app/types.js";
import { Store } from "../storage/store.js";
import { billingSource } from "./auth.js";

export interface InferenceRecord {
  id: string;
  userId: string;
  threadId: string;
  turnId: string;
  route: "wechat-entry" | "project-execution" | "unknown";
  threadModel: string | null;
  actualModel: string | null;
  requestedModel?: string | null;
  reroutedModel?: string | null;
  modelEvidence: string;
  billingSource: string;
  accountCheckedAt: number | null;
  startedAt: number;
  status: string;
  tokens?: Record<string, number>;
}
const modelName = (v: unknown) =>
  typeof v === "string" && /^[\w.\-/:]{1,120}$/.test(v) ? v : null;
// Record only allowlisted metadata; no messages, token credentials or raw RPC payloads.
export class ObservedCodex implements CodexController {
  private threads = new Map<
    string,
    { model: string | null; route: InferenceRecord["route"] }
  >();
  private pending = new Map<
    string,
    Omit<InferenceRecord, "id" | "turnId" | "status">
  >();
  private early = new Map<string, RpcEvent[]>();
  constructor(
    private base: CodexController,
    private store: Store,
    private mock: boolean,
  ) {
    base.onEvent((e) => this.observe(e));
  }
  get connected() {
    return this.base.connected;
  }
  get connectionId() {
    return this.base.connectionId;
  }
  connect() {
    return this.base.connect();
  }
  disconnect() {
    return this.base.disconnect();
  }
  reconnect() {
    return this.base.reconnect();
  }
  onEvent(h: (e: RpcEvent) => void) {
    this.base.onEvent(h);
  }
  respond(id: string | number, result: unknown) {
    this.base.respond(id, result);
  }
  reject(id: string | number, message: string) {
    this.base.reject(id, message);
  }
  async request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (method === "turn/start") {
      let account: any;
      try {
        account = await this.base.request("account/read", {
          refreshToken: false,
        });
      } catch {}
      const threadId = String(params.threadId);
      const thread = this.threads.get(threadId);
      this.pending.set(threadId, {
        userId: this.store.setting("boundUser", ""),
        threadId,
        route: thread?.route ?? "unknown",
        threadModel: thread?.model ?? null,
        actualModel: null,
        requestedModel: modelName(params.model),
        modelEvidence: "not-reported",
        billingSource: this.mock
          ? "mock"
          : account?.requiresOpenaiAuth === true
            ? billingSource(account?.account?.type)
            : "unknown",
        accountCheckedAt: account ? Date.now() : null,
        startedAt: Date.now(),
      });
    }
    try {
      const r = await this.base.request<any>(method, params);
      if (
        ["thread/start", "thread/resume", "thread/fork"].includes(method) &&
        r.thread?.id
      ) {
        this.threads.set(r.thread.id, {
          model: modelName(r.model),
          route: String(params.developerInstructions).includes("智能入口")
            ? "wechat-entry"
            : "project-execution",
        });
      }
      if (method === "turn/start" && r.turn?.id) {
        this.record(
          String(params.threadId),
          r.turn.id,
          r.turn.status,
          r.turn.model,
        );
        for (const e of this.early.get(String(params.threadId)) ?? [])
          if ((e.params.turnId ?? e.params.turn?.id) === r.turn.id)
            this.observe(e);
      }
      return r as T;
    } finally {
      if (method === "turn/start") {
        this.pending.delete(String(params.threadId));
        this.early.delete(String(params.threadId));
      }
    }
  }
  private record(
    threadId: string,
    turnId: string,
    status?: string,
    model?: unknown,
  ) {
    const id = `${threadId}:${turnId}`;
    const existing = this.store.get<InferenceRecord>("inference_records", id);
    const initial = this.pending.get(threadId);
    if (
      !existing &&
      (!initial || initial.userId !== this.store.setting("boundUser", ""))
    )
      return;
    const row: InferenceRecord = existing ?? {
      ...initial!,
      id,
      turnId,
      status: "inProgress",
    };
    // A fast completion can arrive before the turn/start response.
    if (status && !["completed", "failed", "interrupted"].includes(row.status))
      row.status = status;
    const reported = modelName(model);
    if (reported) {
      row.actualModel = reported;
      row.modelEvidence = "turn-reported";
    }
    this.store.put("inference_records", row);
    return row;
  }
  private observe(e: RpcEvent) {
    if (e.connectionId !== this.connectionId || e.id !== undefined) return;
    const threadId = e.params.threadId,
      turnId = e.params.turnId ?? e.params.turn?.id;
    if (!threadId || !turnId) return;
    if (!this.store.get("inference_records", `${threadId}:${turnId}`)) {
      if (this.pending.has(threadId)) {
        const early = this.early.get(threadId) ?? [];
        if (early.length < 100) early.push(e);
        this.early.set(threadId, early);
      }
      return;
    }
    if (e.method === "turn/completed" || e.method === "turn/started")
      this.record(
        threadId,
        turnId,
        e.params.turn?.status,
        e.params.turn?.model,
      );
    if (e.method === "model/rerouted") {
      const row = this.record(threadId, turnId);
      if (row) {
        row.reroutedModel = modelName(e.params.toModel);
        this.store.put("inference_records", row);
      }
    }
    if (e.method === "thread/tokenUsage/updated") {
      const row = this.record(threadId, turnId);
      if (!row) return;
      const last = e.params.tokenUsage?.last;
      if (last) {
        row.tokens = Object.fromEntries(
          [
            "totalTokens",
            "inputTokens",
            "cachedInputTokens",
            "outputTokens",
            "reasoningOutputTokens",
          ]
            .filter((k) => Number.isSafeInteger(last[k]) && last[k] >= 0)
            .map((k) => [k, last[k]]),
        );
        this.store.put("inference_records", row);
      }
    }
  }
}
