import { createHash } from "node:crypto";
import type { CodexController, Task } from "../app/types.js";
import type { WorkspaceCatalog } from "../computer/workspaces.js";
import { executionProject } from "../computer/projects.js";
import { Store } from "../storage/store.js";
import { TaskOrchestrator } from "../tasks/orchestrator.js";
import { safeText } from "../security/policy.js";
import { modelIdentifier } from "./models.js";
import {
  ThreadTargets,
  TargetProblem,
  recentThreadTurns,
  historyRevision,
} from "./thread-target.js";

export const CONTINUATION_REVISION = "original-thread-v1";
export interface ContinuationInput {
  requestId: string;
  projectId: string;
  threadId?: string;
  threadName?: string;
  text: string;
  model?: string;
  expectedHistoryRevision?: string;
}

/** Local authenticated API and the message router share ThreadTargets + TaskOrchestrator. */
export class ThreadContinuation {
  private pending = new Map<
    string,
    { fingerprint: string; promise: Promise<Task> }
  >();
  constructor(
    private store: Store,
    private tasks: TaskOrchestrator,
    private codex: CodexController,
    private catalog?: WorkspaceCatalog,
  ) {}
  private owner(user: string) {
    if (!user || this.store.setting("boundUser", "") !== user)
      throw new TargetProblem("绑定用户已改变，没有继续原对话。");
  }
  private key(user: string, requestId: string) {
    if (
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 160
    )
      throw new TargetProblem("请提供唯一请求编号，避免重复执行。");
    return `continuation:${createHash("sha256")
      .update(JSON.stringify([user, requestId]))
      .digest("hex")}`;
  }
  status(user: string, requestId: string) {
    this.owner(user);
    const key = this.key(user, requestId);
    const task = this.tasks.tasks().find((t) => t.creationId === key);
    if (!task) throw new TargetProblem("没有找到当前用户的续接请求。");
    return task;
  }
  async inspect(
    user: string,
    input: { projectId: string; threadId?: string; threadName?: string },
  ) {
    this.owner(user);
    const project = await executionProject(
      this.tasks,
      this.catalog,
      input.projectId,
    );
    const target = await new ThreadTargets(this.store, this.codex).resolve(
      project,
      user,
      input,
    );
    const history = await recentThreadTurns(this.codex, target.id);
    this.owner(user);
    return {
      projectId: project.id,
      target,
      historyRevision: historyRevision(history.turns),
      hasOlder: history.hasOlder,
      // Conversations and handoff text only; shell output remains in the official client.
      turns: history.turns.map((turn) => ({
        id: turn.id,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        messages: (turn.items ?? [])
          .filter((i: any) => ["userMessage", "agentMessage"].includes(i.type))
          .map((i: any) => ({
            type: i.type,
            text: safeText(
              i.text ??
                (i.content ?? [])
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n"),
              12000,
            ),
          })),
      })),
    };
  }
  async submit(user: string, input: ContinuationInput): Promise<Task> {
    this.owner(user);
    if (
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 8000
    )
      throw new TargetProblem("请说明要在原对话里继续做什么。");
    if (!input.threadId && !input.threadName)
      throw new TargetProblem("想继续这个项目里的哪个对话？");
    const key = this.key(user, input.requestId);
    const model = input.model ? modelIdentifier(input.model) : undefined;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          projectId: input.projectId,
          threadId: input.threadId,
          threadName: input.threadName,
          text: input.text,
          model,
          expectedHistoryRevision: input.expectedHistoryRevision,
        }),
      )
      .digest("hex");
    const saved = this.tasks.tasks().find((t) => t.creationId === key);
    const pending = this.pending.get(key);
    if (saved || pending) {
      if (
        (saved?.continuationFingerprint ?? pending?.fingerprint) !== fingerprint
      )
        throw new TargetProblem("同一请求编号的内容发生变化，没有重复执行。");
      return saved ?? pending!.promise;
    }
    const promise = this.enqueue(user, input, key, fingerprint, model);
    this.pending.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
  private async enqueue(
    user: string,
    input: ContinuationInput,
    key: string,
    fingerprint: string,
    model?: string,
  ) {
    const project = await executionProject(
      this.tasks,
      this.catalog,
      input.projectId,
    );
    this.owner(user);
    const target = await new ThreadTargets(this.store, this.codex).resolve(
      project,
      user,
      input,
    );
    this.owner(user);
    return this.tasks.create(project.id, input.text, undefined, key, {
      thread: target,
      requestedModel: input.model,
      executionModel: model,
      continuationFingerprint: fingerprint,
      expectedHistoryRevision: input.expectedHistoryRevision,
    });
  }
}
