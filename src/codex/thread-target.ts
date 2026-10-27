import { createHash } from "node:crypto";
import type { CodexController, Project } from "../app/types.js";
import { Store } from "../storage/store.js";
import { canonicalProject } from "../security/policy.js";
import { CodexVisibility } from "./visibility.js";

export function historyRevision(turns: unknown[]) {
  return createHash("sha256").update(JSON.stringify(turns)).digest("hex");
}

/** Official, bounded history read. Never reads or changes on-disk Codex storage. */
export async function recentThreadTurns(
  codex: CodexController,
  threadId: string,
) {
  let response: any;
  try {
    response = await codex.request("thread/turns/list", {
      threadId,
      limit: 30,
      sortDirection: "desc",
      itemsView: "full",
    });
  } catch (error) {
    if (/RPC -32601|method not found|unknown method/i.test(String(error)))
      throw new TargetProblem(
        "当前执行端不支持原对话历史查询，没有发送或重放任务。",
      );
    throw new TargetProblem(
      "执行端暂时无法读取原对话历史，没有发送或重放任务。",
    );
  }
  if (!Array.isArray(response?.data))
    throw new TargetProblem("原对话历史未完整返回，没有发送任务。");
  return { turns: response.data as any[], hasOlder: !!response.nextCursor };
}

export class TargetProblem extends Error {}
export interface ThreadTarget {
  id: string;
  name: string;
  projectId?: string;
  membership?: "official" | "unique-workspace";
  cwd: string;
  status: string;
  canAcceptDirectInput?: boolean | null;
}
const key = (s: string) => s.normalize("NFKC").trim().toLowerCase();
const directory = (s: string) => canonicalProject(s).toLowerCase();

/** Metadata only. Never forks, moves, renames or starts a conversation. */
export class ThreadTargets {
  constructor(
    private store: Store,
    private codex: CodexController,
  ) {}
  private assertOwner(owner: string) {
    if (!owner || this.store.setting("boundUser", "") !== owner)
      throw new TargetProblem("微信绑定已改变，这次没有继续。");
  }
  private async scope(project: Project, owner: string) {
    this.assertOwner(owner);
    if (!this.store.get<Project>("projects", project.id))
      throw new TargetProblem("无法访问这个项目，没有读取它的对话。");
    const all = await new CodexVisibility(this.codex).listProjects();
    this.assertOwner(owner);
    const roots = all.filter((p) => {
      return p.roots.some((r) => {
        try {
          return directory(r.path) === directory(project.path);
        } catch {
          return false;
        }
      });
    });
    const matches = roots.filter(
      (p) => !project.codexProjectId || p.id === project.codexProjectId,
    );
    const named = matches.filter((p) => p.name === project.name);
    const candidates = project.codexProjectId
      ? matches
      : named.length
        ? named
        : matches;
    if (candidates.length > 1)
      throw new TargetProblem("同一目录对应多个项目，请明确项目后再选对话。");
    const formal = candidates[0];
    if (project.codexProjectId && !formal)
      throw new TargetProblem(
        "当前无法核实这个正式项目，没有改用其他项目的对话。",
      );
    const ownerHash = createHash("sha256").update(owner).digest("hex");
    if (
      formal?.metadata?.bridgeOwner &&
      formal.metadata.bridgeOwner !== ownerHash
    )
      throw new TargetProblem("这个项目不属于当前绑定用户，没有读取它的对话。");
    return { formalId: formal?.id, allowUnassigned: roots.length <= 1 };
  }
  private candidate(
    raw: any,
    project: Project,
    scope: { formalId?: string; allowUnassigned: boolean },
  ): ThreadTarget | undefined {
    if (!raw || typeof raw.id !== "string" || typeof raw.cwd !== "string")
      return;
    // A directory shared by two projects is not evidence of project membership.
    if (
      raw.projectId != null
        ? raw.projectId !== scope.formalId
        : !scope.allowUnassigned
    )
      return;
    if (this.store.isForeign("codex_sessions", raw.id)) return;
    const known = this.store.get<{ origin?: string }>("codex_sessions", raw.id);
    if (
      known?.origin === "qa" ||
      raw.parentThreadId ||
      raw.ephemeral ||
      /subAgent/.test(JSON.stringify(raw.source ?? ""))
    )
      return;
    try {
      if (directory(raw.cwd) !== directory(project.path)) return;
    } catch {
      return;
    }
    return {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "未命名对话",
      projectId: raw.projectId ?? undefined,
      membership: raw.projectId ? "official" : "unique-workspace",
      cwd: raw.cwd,
      status: raw.status?.type ?? "unknown",
      canAcceptDirectInput: raw.canAcceptDirectInput,
    };
  }
  async list(project: Project, owner: string): Promise<ThreadTarget[]> {
    let scope: { formalId?: string; allowUnassigned: boolean };
    try {
      scope = await this.scope(project, owner);
    } catch (e) {
      if (e instanceof TargetProblem) throw e;
      throw new TargetProblem("暂时访问不到项目的对话列表，还没有安排执行。");
    }
    const found = new Map<string, ThreadTarget>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      let response: any;
      try {
        response = await this.codex.request("thread/list", {
          limit: 100,
          modelProviders: [],
          cwd: project.path,
          // Legacy desktop chats may have no canonical project assignment.
          // Include them only when the selected root maps to one official project.
          ...(!scope.allowUnassigned
            ? { projectId: scope.formalId ?? null }
            : {}),
          ...(cursor ? { cursor } : {}),
        });
      } catch {
        throw new TargetProblem(
          "暂时访问不到这个项目的对话列表，还没有安排执行。",
        );
      }
      this.assertOwner(owner);
      if (!Array.isArray(response?.data))
        throw new TargetProblem("对话列表没有返回完整信息，还没有安排执行。");
      for (const raw of response.data) {
        const candidate = this.candidate(raw, project, scope);
        if (candidate) found.set(candidate.id, candidate);
      }
      if (response.nextCursor == null || response.nextCursor === "")
        return [...found.values()];
      if (
        typeof response.nextCursor !== "string" ||
        cursors.has(response.nextCursor)
      )
        break;
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new TargetProblem("对话列表还没查完整，暂时不能确认唯一目标。");
  }
  async resolve(
    project: Project,
    owner: string,
    query: { threadId?: string | null; threadName?: string | null },
  ) {
    const all = await this.list(project, owner);
    const matches = query.threadId
      ? all.filter((t) => t.id === query.threadId)
      : all.filter((t) => key(t.name) === key(query.threadName ?? ""));
    if (!matches.length)
      throw new TargetProblem(
        "这个项目里没有找到指定对话，暂时没有执行。请核对对话名称或 ID。",
      );
    if (matches.length > 1)
      throw new TargetProblem(
        `这个项目里有多个叫“${matches[0]!.name}”的对话，请用对话 ID 选一个：${matches.map((t) => t.id).join("、")}。`,
      );
    return this.verify(project, owner, matches[0]!.id, matches[0]!.projectId);
  }
  async verify(
    project: Project,
    owner: string,
    threadId: string,
    formalId = project.codexProjectId,
  ): Promise<ThreadTarget> {
    const currentScope = await this.scope(
      { ...project, codexProjectId: formalId },
      owner,
    );
    let response: any;
    try {
      response = await this.codex.request("thread/read", {
        threadId,
        includeTurns: false,
      });
    } catch {
      throw new TargetProblem("暂时访问不到指定对话，没有新建替代对话。");
    }
    this.assertOwner(owner);
    const target = this.candidate(response?.thread, project, currentScope);
    if (!target || target.id !== threadId)
      throw new TargetProblem(
        "指定对话的项目归属或访问范围已变化，没有继续执行。",
      );
    if (target.status === "systemError" || target.status === "unknown")
      throw new TargetProblem("指定对话的运行状态暂时无法确认，没有继续执行。");
    return target;
  }
}
