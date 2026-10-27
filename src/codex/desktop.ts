import type { CodexController, Project } from "../app/types.js";
import { canonicalProject } from "../security/policy.js";
export class DesktopSessionAdapter {
  readonly capabilities = {
    list: true,
    read: true,
    fork: true,
    liveDesktopSync: false,
    controlDesktopRunningTurn: false,
  };
  constructor(private codex: CodexController) {}
  async list(cwd: string, cursor?: string) {
    const r = await this.codex.request("thread/list", {
      limit: 30,
      modelProviders: [],
      cwd,
      ...(cursor ? { cursor } : {}),
    });
    return {
      data: r.data.map((t: any) => ({
        id: t.id,
        name: t.name ?? "未命名会话",
        cwd: t.cwd,
        status: t.status,
        createdAt: t.createdAt,
      })),
      nextCursor: r.nextCursor,
    };
  }
  async fork(project: Project, threadId: string) {
    const r = await this.codex.request("thread/read", { threadId });
    if (canonicalProject(r.thread.cwd) !== canonicalProject(project.path))
      throw new Error("会话工作目录与授权项目不一致");
    if (r.thread.status?.type === "active")
      throw new Error("桌面会话正在执行，请结束后再分叉");
    return this.codex.request("thread/fork", {
      threadId,
      cwd: project.path,
      excludeTurns: true,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
  }
}
