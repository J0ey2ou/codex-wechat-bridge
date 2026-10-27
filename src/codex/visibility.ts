import { createHash } from "node:crypto";
import path from "node:path";
import { realpathSync } from "node:fs";
import type { CodexController } from "../app/types.js";
import { canonicalProject } from "../security/policy.js";

export interface VisibleProject {
  id: string;
  name: string;
  path: string;
  codexProjectId?: string;
}

export interface OfficialProject {
  id: string;
  name: string;
  roots: { path: string }[];
  metadata?: Record<string, string>;
}

const MAX_PAGES = 100;

function identity(directory: string) {
  const normalized = path.normalize(directory);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalRoot(directory: string): string | undefined {
  if (!path.isAbsolute(directory)) return undefined;
  try {
    return identity(realpathSync.native(directory));
  } catch {
    // Stale or unavailable project roots cannot establish a matching location.
    return undefined;
  }
}

export function officialProject(value: unknown): OfficialProject {
  if (!value || typeof value !== "object")
    throw new Error("Codex 返回的项目记录无效，未创建新项目");
  const p = value as Partial<OfficialProject>;
  if (
    typeof p.id !== "string" ||
    !p.id.trim() ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    !Array.isArray(p.roots) ||
    p.roots.some(
      (root) =>
        !root || typeof root.path !== "string" || !path.isAbsolute(root.path),
    )
  )
    throw new Error("Codex 返回的项目记录无效，未创建新项目");
  return p as OfficialProject;
}

/** Public metadata calls only: making a thread visible must never start model work. */
export class CodexVisibility {
  private pending = new Map<string, Promise<string>>();

  constructor(private codex: Pick<CodexController, "request">) {}

  async ensureProject(project: VisibleProject): Promise<string> {
    if (typeof project.name !== "string" || !project.name.trim())
      throw new Error("项目名称不能为空");
    if (
      project.codexProjectId !== undefined &&
      (typeof project.codexProjectId !== "string" ||
        !project.codexProjectId.trim())
    )
      throw new Error("Codex 项目 ID 无效");
    const directory = canonicalProject(project.path);
    const key = JSON.stringify([
      identity(directory),
      project.codexProjectId ?? null,
      project.name,
    ]);
    const previous = this.pending.get(key);
    if (previous) return previous;
    const request = this.findOrCreate(project, directory);
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  async listProjects(): Promise<OfficialProject[]> {
    const projects = new Map<string, OfficialProject>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.codex.request<{
        data?: unknown;
        nextCursor?: unknown;
      }>("project/list", {
        limit: 100,
        sortKey: "position",
        ...(cursor ? { cursor } : {}),
      });
      if (!response || !Array.isArray(response.data))
        throw new Error("Codex 项目列表无效，未创建新项目");
      for (const value of response.data) {
        const project = officialProject(value);
        projects.set(project.id, project);
      }
      const next = response.nextCursor;
      if (next == null || next === "") return [...projects.values()];
      if (typeof next !== "string" || cursors.has(next))
        throw new Error("Codex 项目分页未正常结束，未创建新项目");
      cursors.add(next);
      cursor = next;
    }
    throw new Error("Codex 项目列表未读取完整，未创建新项目");
  }

  private async findOrCreate(project: VisibleProject, directory: string) {
    // Finish every page before deciding absence or ambiguity; RPC failure is not absence.
    const all = await this.listProjects();
    const target = identity(directory);
    const matches = all.filter((candidate) =>
      candidate.roots.some((root) => canonicalRoot(root.path) === target),
    );
    if (project.codexProjectId) {
      const explicit = matches.find(
        (candidate) => candidate.id === project.codexProjectId,
      );
      if (!explicit)
        throw new Error("指定的 Codex 项目不存在或目录不匹配，未创建新项目");
      return explicit.id;
    }
    const sameName = matches.filter(
      (candidate) => candidate.name === project.name,
    );
    if (sameName.length === 1) return sameName[0]!.id;
    if (sameName.length > 1 || matches.length > 1)
      throw new Error("同一目录对应多个 Codex 项目，请明确要关联的项目");
    if (matches.length === 1) return matches[0]!.id;

    const response = await this.codex.request<{ project?: unknown }>(
      "project/create",
      {
        idempotencyKey:
          "codex-wechat-project-" +
          createHash("sha256").update(target).digest("hex"),
        name: project.name,
        roots: [{ path: directory }],
      },
    );
    const created = officialProject(response?.project);
    if (!created.roots.some((root) => canonicalRoot(root.path) === target))
      throw new Error("Codex 创建结果的项目目录不匹配");
    return created.id;
  }

  async attachThread(threadId: string, projectId: string): Promise<void> {
    if (!threadId?.trim() || !projectId?.trim())
      throw new Error("关联会话需要真实的会话和项目 ID");
    await this.codex.request("thread/metadata/update", { threadId, projectId });
  }

  async setName(threadId: string, name: string): Promise<void> {
    if (!threadId?.trim() || !name?.trim())
      throw new Error("会话 ID 和名称不能为空");
    await this.codex.request("thread/name/set", { threadId, name });
  }
}
