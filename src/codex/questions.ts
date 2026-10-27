import path from "node:path";
import { dialogueContext } from "../app/dialogue.js";
import { TargetProblem } from "./thread-target.js";
import { mkdirSync } from "node:fs";
import type { Config } from "../app/config.js";
import type { CodexController, RpcEvent, Delivery } from "../app/types.js";
import { Store } from "../storage/store.js";
import { NotificationManager } from "../notifications/outbox.js";
import { safeText } from "../security/policy.js";
import {
  IntentDispatcher,
  INTENT_INSTRUCTIONS,
  INTENT_SCHEMA,
  INTENT_REVISION,
  type Intent,
} from "../app/intent.js";
import { normalizeComputerCall } from "../computer/protocol.js";
import { MemoryManager } from "../app/memory.js";
import { CodexVisibility } from "./visibility.js";
import {
  wantsReceipt,
  friendlyProblem,
} from "../notifications/presentation.js";
import {
  conciseReply,
  detailsRequested,
} from "../notifications/task-message.js";

export interface Question {
  id: string;
  userId: string;
  text: string;
  status: "queued" | "running" | "dispatching" | "completed" | "failed";
  decision?: Intent;
  createdAt: number;
  startedAt?: number;
  turnStartedAt?: number;
  toolCalls?: { request: string; result: unknown; completedAt: number }[];
  endedAt?: number;
  threadId?: string;
  turnId?: string;
  connectionId?: string;
  answer?: string;
  replyText?: string;
  error?: string;
  protocolVersion?: string;
  repairAttempts?: number;
  memoryRevision?: number;
  preparedAt?: number;
  decisionAt?: number;
  turnTimings?: {
    startedAt: number;
    acceptedAt?: number;
    completedAt?: number;
  }[];
}

// Ordinary messages first enter a durable Codex analysis thread. Only validated decisions reach business services.
export class QuestionManager {
  onQueued?: () => void;
  private busy = false;
  private active?: string;
  private events = Promise.resolve();
  private startingTurns = new Set<string>();
  private earlyEvents = new Map<string, RpcEvent[]>();
  private sessionKey(userId: string) {
    return `qa-session:${userId}`;
  }
  constructor(
    private store: Store,
    private codex: CodexController,
    private notices: NotificationManager,
    private config: Config,
    private dispatcher: IntentDispatcher,
  ) {
    codex.onEvent((e) => this.queueEvent(e));
  }
  private queueEvent(e: RpcEvent) {
    this.events = this.events
      .then(() => this.handle(e))
      .catch((error) => {
        if (this.active) {
          const q = this.store.get<Question>("questions", this.active);
          if (q)
            this.fail(q, "这条消息处理未完成，请稍后再试。", String(error));
        }
      });
  }
  async drained() {
    for (;;) {
      const pending = this.events;
      await pending;
      if (pending === this.events) return;
    }
  }
  enqueue(text: string, userId: string, messageId: string): string {
    const inserted = this.store.insert<Question>("questions", {
      id: messageId,
      userId,
      text,
      status: "queued",
      createdAt: Date.now(),
    });
    if (inserted) {
      if (wantsReceipt(text)) this.notices.scheduleReceipt(messageId, userId);
      this.onQueued?.();
    }
    return "";
  }
  recover() {
    for (const delivery of this.store.all<Delivery>(
      "notification_deliveries",
    )) {
      if (
        delivery.dedupeKey.startsWith("answer-wait:") &&
        ["pending", "retry"].includes(delivery.status)
      ) {
        delivery.status = "cancelled";
        this.store.put("notification_deliveries", delivery);
      }
    }
    for (const q of this.store.all<Question>("questions")) {
      if (["running", "dispatching"].includes(q.status))
        this.fail(
          q,
          "服务重启，上条消息的处理结果未确认。可先查看当前任务或待办，避免重复操作。",
          "interrupted by restart",
        );
    }
  }
  private finish(q: Question, text: string, error?: string) {
    if (
      !["running", "dispatching"].includes(
        this.store.get<Question>("questions", q.id)?.status ?? "",
      )
    )
      return;
    this.store.transaction(() => {
      q.status = error ? "failed" : "completed";
      q.answer = text;
      q.replyText = conciseReply(text, q.text);
      q.error = error;
      q.endedAt = Date.now();
      this.store.put("questions", q);
      if (!error && q.userId === this.store.setting("boundUser", ""))
        new MemoryManager(this.store).observe(
          q.userId,
          q.text,
          q.memoryRevision ?? 0,
        );
      const ackOnly =
        !error &&
        ["run", "continue"].includes(q.decision?.action ?? "") &&
        text === "收到了，我处理一下。";
      const deliveryId = this.notices.reply(
        q.replyText,
        `answer:${q.id}`,
        q.userId,
        q.id,
        ackOnly,
      );
      if (deliveryId) {
        q.replyText =
          this.store.get<Delivery>("notification_deliveries", deliveryId)
            ?.text ?? q.replyText;
        this.store.put("questions", q);
      }
      if (error) this.store.setSetting(this.sessionKey(q.userId), null);
    });
    if (this.active === q.id) this.active = undefined;
    this.onQueued?.();
  }
  private fail(q: Question, text: string, error: string) {
    this.finish(q, text, safeText(error));
  }
  async pump() {
    if (this.busy || this.active) return;
    const q = this.store
      .all<Question>("questions")
      .filter((q) => q.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!q) return;
    this.busy = true;
    this.active = q.id;
    q.status = "running";
    q.startedAt = Date.now();
    q.protocolVersion = INTENT_REVISION;
    q.connectionId = this.codex.connectionId;
    this.store.put("questions", q);
    try {
      if (q.userId !== this.store.setting("boundUser", ""))
        throw new Error("绑定已变更");
      if (!this.codex.connected) throw new Error("Codex 未连接");
      const profile = new MemoryManager(this.store).profile(q.userId);
      q.memoryRevision = profile.revision;
      const cwd = path.join(this.config.dataDir, "qa-workspace");
      mkdirSync(cwd, { recursive: true });
      const saved =
        this.store.setting<string>(`qa-protocol:${q.userId}`, "") ===
          INTENT_REVISION && profile.enabled
          ? this.store.setting<string | null>(this.sessionKey(q.userId), null)
          : null;
      const visibility = new CodexVisibility(this.codex);
      let visibleProjectId: string | undefined;
      try {
        visibleProjectId = await visibility.ensureProject({
          id: "bridge-questions",
          name: "鲁滨逊",
          path: process.cwd(),
        });
      } catch (error) {
        this.store.setSetting(
          `qa-visibility:${q.userId}`,
          safeText(String(error), 500),
        );
      }
      if (
        this.store.get<Question>("questions", q.id)?.status !== "running" ||
        q.userId !== this.store.setting("boundUser", "")
      )
        return;
      const params = {
        cwd,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "read-only",
        developerInstructions: INTENT_INSTRUCTIONS,
        config: {
          "features.shell_tool": false,
          "features.apps": false,
          "features.plugins": false,
          web_search: "disabled",
          "apps._default.enabled": false,
        },
      };
      const r = saved
        ? await this.codex.request("thread/resume", {
            ...params,
            threadId: saved,
            excludeTurns: true,
          })
        : await this.codex.request("thread/start", {
            ...params,
            ...(visibleProjectId ? { projectId: visibleProjectId } : {}),
          });
      if (this.store.get<Question>("questions", q.id)?.status !== "running")
        return;
      q.threadId = r.thread.id;
      this.store.put("codex_sessions", {
        id: q.threadId!,
        origin: "qa",
        userId: q.userId,
      });
      this.store.setSetting(this.sessionKey(q.userId), q.threadId);
      this.store.setSetting(`qa-protocol:${q.userId}`, INTENT_REVISION);
      this.store.put("questions", q);
      try {
        if (saved && visibleProjectId)
          await visibility.attachThread(q.threadId!, visibleProjectId);
        if (!saved) await visibility.setName(q.threadId!, "微信问答 · 鲁滨逊");
      } catch (error) {
        this.store.setSetting(
          `qa-visibility:${q.userId}`,
          safeText(String(error), 500),
        );
      }
      if (
        this.store.get<Question>("questions", q.id)?.status !== "running" ||
        q.userId !== this.store.setting("boundUser", "")
      )
        return;
      q.preparedAt = Date.now();
      await this.startTurn(q);
    } catch (e) {
      const latest = this.store.get<Question>("questions", q.id)!;
      const message =
        "这次未能连接上 Codex 分析这条消息，暂时没拿到回答。请稍后再发一次。";
      this.fail(latest, message, e instanceof Error ? e.message : String(e));
    } finally {
      this.busy = false;
    }
  }
  private async startTurn(q: Question, observation?: unknown) {
    q.turnId = undefined;
    q.answer = undefined;
    q.replyText = undefined;
    q.status = "running";
    q.turnStartedAt = Date.now();
    q.turnTimings = [...(q.turnTimings ?? []), { startedAt: q.turnStartedAt }];
    this.startingTurns.add(q.id);
    this.store.put("questions", q);
    try {
      const turn = await this.codex.request("turn/start", {
        threadId: q.threadId,
        input: [
          {
            type: "text",
            text: JSON.stringify({
              bridgeContext: this.dispatcher.context(
                q.userId,
                detailsRequested(q.text),
              ),
              userMessage: q.text,
              replyStyle: dialogueContext(q.text),
              ...(observation === undefined
                ? {}
                : {
                    computerObservation: observation,
                    toolCallsRemaining: 12 - (q.toolCalls?.length ?? 0),
                  }),
            }),
          },
        ],
        outputSchema: INTENT_SCHEMA,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        effort: "low",
      });
      const latest = this.store.get<Question>("questions", q.id)!;
      if (latest.turnTimings?.length) {
        latest.turnTimings[latest.turnTimings.length - 1]!.acceptedAt =
          Date.now();
        this.store.put("questions", latest);
      }
      if (latest.status === "running" && !latest.turnId) {
        latest.turnId = turn.turn.id;
        this.store.put("questions", latest);
        for (const event of this.earlyEvents.get(q.id) ?? []) {
          if ((event.params.turnId ?? event.params.turn?.id) === latest.turnId)
            this.queueEvent(event);
        }
      }
    } finally {
      this.startingTurns.delete(q.id);
      this.earlyEvents.delete(q.id);
    }
  }
  monitor(now = Date.now()) {
    if (!this.active) return;
    const q = this.store.get<Question>("questions", this.active);
    if (!q || !["running", "dispatching"].includes(q.status)) {
      this.active = undefined;
      return;
    }
    const elapsed = now - (q.turnStartedAt ?? q.startedAt ?? now);
    if (elapsed >= 90000 || now - (q.startedAt ?? now) >= 360000) {
      this.fail(
        q,
        q.status === "dispatching"
          ? "这次操作等待超时，结果尚未确认。请先核对任务或待办状态，避免重复操作。"
          : "这次 Codex 等待超时，暂时没拿到完整回答。请稍后再试。",
        "question timeout",
      );
      if (q.threadId && q.turnId && this.codex.connected)
        void this.codex
          .request("turn/interrupt", { threadId: q.threadId, turnId: q.turnId })
          .catch(() => {});
    }
  }
  private async handle(e: RpcEvent) {
    if (e.connectionId !== this.codex.connectionId) return;
    if (e.method === "bridge/disconnected") {
      if (this.active) {
        const q = this.store.get<Question>("questions", this.active);
        if (q)
          this.fail(
            q,
            "问答连接中断，刚才的问题未能回答。连接恢复后可以再问一次。",
            "connection lost",
          );
      }
      return;
    }
    const owned =
      this.store.get<{ origin: string }>(
        "codex_sessions",
        e.params.threadId ?? "",
      )?.origin === "qa";
    if (!owned) return;
    if (e.id !== undefined) {
      // Question threads cannot obtain permission to run operations, even when the model asks.
      if (
        e.method === "item/commandExecution/requestApproval" ||
        e.method === "item/fileChange/requestApproval"
      )
        this.codex.respond(e.id, { decision: "decline" });
      else if (e.method === "item/permissions/requestApproval")
        this.codex.respond(e.id, { permissions: {}, scope: "turn" });
      else this.codex.reject(e.id, "This is a text-only question session");
      return;
    }
    if (!this.active) return;
    const q = this.store.get<Question>("questions", this.active);
    if (!["item/completed", "turn/completed"].includes(e.method)) return;
    const turnId = e.params.turnId ?? e.params.turn?.id;
    if (
      q &&
      q.status === "running" &&
      q.threadId === e.params.threadId &&
      this.startingTurns.has(q.id) &&
      !q.turnId
    ) {
      if (turnId) {
        const early = this.earlyEvents.get(q.id) ?? [];
        if (early.length < 100) early.push(e);
        this.earlyEvents.set(q.id, early);
      }
      return;
    }
    if (
      !q ||
      q.status !== "running" ||
      q.threadId !== e.params.threadId ||
      q.connectionId !== e.connectionId ||
      !q.turnId ||
      !turnId ||
      q.turnId !== turnId
    )
      return;
    if (turnId) q.turnId = turnId;
    if (
      e.method === "item/completed" &&
      e.params.item?.type === "agentMessage"
    ) {
      q.answer = String(e.params.item.text ?? "").slice(0, 12000);
    }
    if (e.method === "turn/completed") {
      if (q.turnTimings?.length)
        q.turnTimings[q.turnTimings.length - 1]!.completedAt = Date.now();
      if (e.params.turn.status === "completed" && q.answer?.trim()) {
        try {
          try {
            q.decision = this.dispatcher.parse(q.answer);
          } catch (error) {
            if ((q.repairAttempts ?? 0) >= 2)
              throw new Error("这次查询暂未完成，请稍后重试");
            q.repairAttempts = (q.repairAttempts ?? 0) + 1;
            await this.startTurn(q, {
              kind: "decision_format_repair",
              error: safeText(
                error instanceof Error ? error.message : error,
                500,
              ),
              instruction:
                "内部参数格式修复：按当前outputSchema重新输出。action=computer时把真实工具参数写入computer对象，text=null。不要向用户转述此错误或要求用户提供JSON；修正后继续完成原需求。",
            });
            return;
          }
          q.status = "dispatching";
          q.decisionAt = Date.now();
          this.store.put("questions", q); // Claim the decision before any side effects; never replay after restart.
          if (q.userId !== this.store.setting("boundUser", ""))
            throw new Error("绑定用户已改变");
          if (q.decision.action === "computer") {
            if (!this.dispatcher.computer)
              throw new Error("本机读取能力当前未连接");
            if ((q.toolCalls?.length ?? 0) >= 12)
              throw new Error(
                "本次自动查找已达到上限，尚未取得完整结果；请缩小查询范围",
              );
            const requested = normalizeComputerCall(q.decision.computer);
            const request = JSON.stringify(requested);
            let result: unknown;
            try {
              const prior =
                requested?.tool === "open_app"
                  ? q.toolCalls?.find((call) => {
                      try {
                        const p = JSON.parse(call.request);
                        return p.tool === "open_app" && p.id === requested.id;
                      } catch {
                        return false;
                      }
                    })
                  : undefined;
              result = prior
                ? { previousResult: prior.result, alreadyRequested: true }
                : await this.dispatcher.computer.observe(requested);
            } catch (error) {
              result = {
                error: safeText(
                  error instanceof Error ? error.message : error,
                  500,
                ),
              };
            }
            if (
              this.store.get<Question>("questions", q.id)?.status !==
              "dispatching"
            )
              return;
            // Preserve facts for audit, but never replay an action after a restart.
            const clipped = JSON.stringify(result).slice(0, 45000);
            const observation =
              clipped.length < JSON.stringify(result).length
                ? { truncated: true, partial: clipped }
                : result;
            q.toolCalls = [
              ...(q.toolCalls ?? []),
              { request, result: observation, completedAt: Date.now() },
            ];
            this.store.put("questions", q);
            if (q.userId !== this.store.setting("boundUser", ""))
              throw new Error("绑定用户已改变");
            await this.startTurn(q, { request, result: observation });
            return;
          }
          if (
            ["run", "continue"].includes(q.decision.action) ||
            (q.decision.action === "create_project" &&
              q.decision.newProject?.name)
          )
            this.notices.scheduleReceipt(q.id, q.userId, q.createdAt);
          const answer = await this.dispatcher.execute(
            q.decision,
            q.text,
            q.id,
            q.userId,
          );
          this.finish(q, answer);
        } catch (error) {
          this.fail(
            q,
            q.decision?.action === "account"
              ? "我明白你是在问账号用量，但这次官方接口查询失败，暂时查不到实际额度，也无法换算成剩余 token 数。"
              : error instanceof TargetProblem
                ? error.message
                : friendlyProblem(
                    error instanceof Error ? error.message : error,
                  ),
            String(error),
          );
        }
      } else
        this.fail(
          q,
          "这次没有获得完整回答。请稍后再试，我不会把这个问题自动转为待办。",
          e.params.turn.error?.message ?? e.params.turn.status,
        );
      return;
    }
    this.store.put("questions", q);
  }
}
