import type { Project, Task } from "./types.js";
import type { CodexController } from "./types.js";
import type { WorkspaceCatalog } from "../computer/workspaces.js";
import { executionProject } from "../computer/projects.js";
import { Store } from "../storage/store.js";
import { TaskOrchestrator } from "../tasks/orchestrator.js";
import { ThreadTargets, TargetProblem } from "../codex/thread-target.js";
import { modelIdentifier } from "../codex/models.js";

export interface TargetSelection {
  requestId: string | null;
  threadName: string | null;
  threadId: string | null;
  model?: string | null;
}
export interface RoutingRequest {
  id: string;
  userId: string;
  original: string;
  messages: { id: string; text: string }[];
  projectId?: string;
  projectName?: string;
  threadName?: string;
  threadId?: string;
  requestedModel?: string;
  taskId?: string;
  state: "awaiting_target" | "blocked" | "dispatched";
  lastReply: string;
  updatedAt: number;
}
type RoutingDecision = {
  action: string;
  projectId: string | null;
  taskId: string | null;
  text: string | null;
  target?: TargetSelection | null;
};

// Conservative candidate extraction, not a command or an authorization decision.
// It is applied only after the normal intent decision, never to forwarded messages.
export function threadNameHint(text: string): string | undefined {
  if (
    text.length > 500 ||
    /(?:怎么|如何|为什么|修复|实现).{0,12}(?:解析|路由|机制|功能)|用户(?:说|要求)|例如|举例/.test(
      text,
    )
  )
    return;
  const explicit =
    text.match(
      /(?:对话|会话)(?:叫|名为|名称为)?\s*[“「"']([^”」"'\n]{1,80})[”」"']/,
    )?.[1] ??
    text.match(
      /(?:对话|会话)(?:叫|名为|名称为)?\s*([\p{L}\p{N}_-]{1,40}?)(?=\s|里|中|，|。|、|$)/u,
    )?.[1];
  if (explicit) return explicit;
  const short = text.match(
    /^(?:请|麻烦|帮我)?(?:让|用|在)\s*[“「"']?([^\s，。！？“”「」"']{1,16}?)[”」"']?(?:来|里|中)(?:继续|处理|覆盖|同步|开展|执行|做)/,
  )?.[1];
  return short && !/^(?:方案|产物|结果|版本|选项)/.test(short)
    ? short
    : undefined;
}

/** Durable clarification state. Kept separate from personal memory and model history. */
export class TargetRouting {
  private busy = new Set<string>();
  constructor(
    private store: Store,
    private tasks: TaskOrchestrator,
    private codex: CodexController,
    private catalog?: WorkspaceCatalog,
  ) {}
  context(userId: string) {
    return this.store
      .all<RoutingRequest>("routing_requests")
      .filter((r) => r.userId === userId)
      .slice(0, 8)
      .map(
        ({
          id,
          original,
          projectId,
          projectName,
          threadName,
          threadId,
          requestedModel,
          taskId,
          state,
          lastReply,
          messages,
        }) => ({
          id,
          original: original.slice(0, 1200),
          projectId,
          projectName,
          threadName,
          threadId,
          requestedModel,
          taskId,
          state,
          lastReply,
          clarifications: messages
            .slice(-2)
            .map((m) => ({ id: m.id, text: m.text.slice(0, 500) })),
        }),
      );
  }
  private assertOwner(userId: string) {
    if (!userId || this.store.setting("boundUser", "") !== userId)
      throw new TargetProblem("微信绑定已改变，这次没有继续。");
  }
  private projectMention(text: string) {
    const normalized = text
      .trim()
      .replace(/^[是就用在]+/, "")
      .replace(/[。！!\s]+$/, "");
    const entries = this.catalog?.snapshot().projects ?? this.tasks.projects();
    return entries.filter((p) =>
      [p.name, `${p.name}项目`].includes(normalized),
    );
  }
  async handle(
    p: RoutingDecision,
    original: string,
    messageId: string,
    userId: string,
  ): Promise<string | undefined> {
    this.assertOwner(userId);
    const records = this.store
      .all<RoutingRequest>("routing_requests")
      .filter((r) => r.userId === userId);
    const replay = records.find((r) =>
      r.messages.some((m) => m.id === messageId),
    );
    if (replay) return replay.lastReply;
    let hint = threadNameHint(original) ?? p.target?.threadName;
    if (
      !p.target &&
      !/(?:对话|会话)/.test(original) &&
      [
        ...this.tasks.projects(),
        ...(this.catalog?.snapshot().projects ?? []),
      ].some((project) => project.name === hint)
    )
      hint = undefined;
    const pending = records.filter((r) => r.state !== "dispatched");
    const mentions = this.projectMention(original);
    let record = p.target?.requestId
      ? records.find((r) => r.id === p.target!.requestId)
      : undefined;
    if (p.target?.requestId && !record)
      throw new TargetProblem(
        "原请求不在当前用户的可用记录里，请重新说明目标。",
      );
    const clarification =
      original.length <= 200 &&
      (mentions.length > 0 ||
        /^(?:是|就|在)?[^。！？]{0,70}(?:对话|会话)(?:叫|名为|是)?/.test(
          original,
        ));
    if (!record && clarification && pending.length === 1) record = pending[0];
    if (!record && clarification && pending.length > 1)
      return "有几条请求还在等目标，请说明这次补充的是哪一件事。";
    const actionable =
      ["run", "continue", "resolve_target"].includes(p.action) ||
      (p.action === "answer" &&
        !!threadNameHint(original) &&
        /覆盖|同步|执行|开展|处理|修改|继续/.test(original) &&
        !/[？?]|可以吗|行不行|是否|能否|怎么|如何/.test(original));
    if (!record && !((hint || p.target?.threadId) && actionable))
      return undefined;
    // A model may explicitly link a clarification, but cannot turn unrelated tool/account actions into work.
    if (!["answer", "run", "continue", "resolve_target"].includes(p.action))
      return undefined;
    record ??= {
      id: messageId,
      userId,
      original,
      messages: [],
      threadName: hint ?? undefined,
      state: "awaiting_target",
      lastReply: "这是哪个项目里的对话？",
      updatedAt: Date.now(),
    };
    if (this.busy.has(record.id)) return "这条要求正在确认目标，不会重复安排。";
    this.busy.add(record.id);
    try {
      const prior = this.store.get<RoutingRequest>(
        "routing_requests",
        record.id,
      );
      if (prior) record = prior;
      const existingTask = this.tasks
        .tasks()
        .find(
          (t) =>
            t.id === record!.taskId ||
            t.routingRequestId === record!.id ||
            t.sourceMessageIds?.includes(record!.id),
        );
      if (existingTask) record.taskId = existingTask.id;
      record.messages.push({ id: messageId, text: original });
      if (p.target?.model) record.requestedModel = p.target.model;
      record.updatedAt = Date.now();
      const save = (reply: string, state = record!.state) => {
        this.assertOwner(userId);
        record!.lastReply = reply;
        record!.state = state;
        this.store.put("routing_requests", record!);
        return reply;
      };
      save(record.lastReply);
      if (
        mentions.length > 1 &&
        !(p.projectId && original.includes(p.projectId))
      )
        return save(
          "有多个同名项目，请说明要用哪一个项目 ID。",
          "awaiting_target",
        );
      const entries =
        this.catalog?.snapshot().projects ?? this.tasks.projects();
      const explicitNames = [
        ...new Set(
          entries
            .filter(
              (entry) =>
                original.includes(`${entry.name}项目`) ||
                original.includes(`项目${entry.name}`) ||
                original.includes(`“${entry.name}”`) ||
                (entry.name.length >= 3 && original.includes(entry.name)),
            )
            .map((entry) => entry.name),
        ),
      ];
      const explicitName =
        explicitNames.length === 1 ? explicitNames[0] : undefined;
      const selectedProject =
        p.projectId && original.includes(p.projectId)
          ? p.projectId
          : (explicitName ?? p.projectId ?? record.projectId);
      if (!selectedProject)
        return save("这是哪个项目里的对话？", "awaiting_target");
      this.tasks.notices.scheduleReceipt(messageId, userId);
      let project: Project;
      try {
        project = await executionProject(
          this.tasks,
          this.catalog,
          selectedProject,
        );
      } catch {
        return save(
          "暂时无法唯一确认这个项目，请核对项目名称或 ID。",
          "blocked",
        );
      }
      this.assertOwner(userId);
      const query = {
        threadId: p.target?.threadId || (hint ? undefined : record.threadId),
        threadName: hint || record.threadName,
      };
      if (!query.threadId && !query.threadName)
        return save("想接着这个项目里的哪个对话做？", "awaiting_target");
      // Do not send the original work to a new destination once execution may have occurred.
      if (
        existingTask &&
        !this.tasks.canAmend(existingTask) &&
        (existingTask.projectId !== project.id ||
          (query.threadId && query.threadId !== existingTask.targetThreadId) ||
          (!query.threadId &&
            query.threadName !== existingTask.targetThreadName))
      )
        return save(
          "原请求已经开始处理，不能自动换对话重做；请先核对当前结果。",
          "blocked",
        );
      record.projectId = project.id;
      record.projectName = project.name;
      record.threadName = query.threadName ?? record.threadName;
      // Save clarification even if discovery is unavailable; never lose the original requirements.
      save(record.lastReply);
      let target;
      try {
        target = await new ThreadTargets(this.store, this.codex).resolve(
          project,
          userId,
          query,
        );
      } catch (e) {
        if (e instanceof TargetProblem) return save(e.message, "blocked");
        throw e;
      }
      this.assertOwner(userId);
      record.threadId = target.id;
      record.threadName = target.name;
      const requirements = [
        record.original,
        ...record.messages
          .filter((m) => m.id !== record!.id)
          .map((m) => `用户补充：${m.text}`),
      ].join("\n\n");
      if (requirements.length > 8000)
        return save(
          "合并后的要求太长，原内容已留后台，还没有派发。",
          "blocked",
        );
      let task: Task;
      const executionModel = record.requestedModel
        ? modelIdentifier(record.requestedModel)
        : undefined;
      if (existingTask) {
        if (
          !this.tasks.canAmend(existingTask) &&
          p.action === "continue" &&
          p.text?.trim()
        ) {
          this.tasks.continue(existingTask.projectId, original, {
            taskId: existingTask.id,
            messageId,
            requestedModel: record.requestedModel,
            executionModel,
          });
          return save(
            "补充要求已排好，会在当前任务结束后接着同一对话处理。",
            "dispatched",
          );
        }
        if (!this.tasks.canAmend(existingTask))
          return save(
            existingTask.targetResumedAt
              ? "原请求已经进入指定对话，没有重复派发。"
              : "原请求已登记，但尚未确认进入指定对话；没有自动重试。",
            "dispatched",
          );
        if (existingTask.projectId !== project.id)
          return save(
            "原请求已经排入另一个项目，不能自动跨项目移动任务。",
            "blocked",
          );
        task = this.tasks.amend(existingTask, original, messageId);
        this.tasks.bindThread(task, target);
        if (executionModel) {
          task.requestedModel = record.requestedModel;
          task.executionModel = executionModel;
          this.store.put("tasks", task);
        }
      } else {
        const matching = this.tasks
          .tasks()
          .filter(
            (t) =>
              t.projectId === project.id &&
              (t.targetThreadId ?? t.threadId) === target.id,
          );
        const active = matching.filter((t) =>
          [
            "RUNNING",
            "WAITING_PROCESS",
            "WAITING_APPROVAL",
            "UNKNOWN",
          ].includes(t.status),
        );
        const queued = matching.filter((t) => t.status === "QUEUED");
        if (
          p.action === "continue" &&
          !p.taskId &&
          !active.length &&
          queued.length > 1
        )
          return save(
            "这个对话有多项排队要求，请说明要补充哪一项。",
            "awaiting_target",
          );
        const previous = p.taskId
          ? matching.find((t) => t.id === p.taskId)
          : (active[0] ?? queued[0] ?? matching[0]);
        if (p.taskId && !previous)
          return save("指定任务不属于这个对话，没有合并或执行。", "blocked");
        task =
          p.action === "continue" && previous
            ? this.tasks.continue(project.id, requirements, {
                taskId: previous.id,
                messageId,
                requestedModel: record.requestedModel,
                executionModel,
              })
            : this.tasks.create(
                project.id,
                requirements,
                undefined,
                `routing:${record.id}`,
                {
                  thread: target,
                  routingRequestId: record.id,
                  requestedModel: record.requestedModel,
                  executionModel,
                },
              );
        for (const message of record.messages)
          this.tasks.linkMessage(task, message.id);
      }
      record.taskId = task.id;
      return save(
        target.status === "active"
          ? `已找到“${project.name}”里的对话“${target.name}”，要求已排队，等当前轮结束后接着处理。`
          : `已找到“${project.name}”里的对话“${target.name}”，要求已排队，会承接它的上下文。`,
        "dispatched",
      );
    } finally {
      this.busy.delete(record.id);
    }
  }
}
