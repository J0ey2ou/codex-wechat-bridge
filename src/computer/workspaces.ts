import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "../app/config.js";
import type { CodexController, Project } from "../app/types.js";
import { canonicalProject, safeText, within } from "../security/policy.js";

export type WorkspaceSource = "registered" | "codex" | "registered+codex";
export interface Workspace {
  id: string;
  name: string;
  path: string;
  source: WorkspaceSource;
  lastActive?: number;
  registered: boolean;
  projectIds?: string[];
  projectNames?: string[];
}
export interface WorkspaceProject {
  id: string;
  name: string;
  workspaceIds: string[];
  source: "codex" | "workspace";
  lastActive?: number;
}
export interface WorkspaceSnapshot {
  workspaces: Workspace[];
  projects: WorkspaceProject[];
  error?: string;
  updatedAt?: number;
  currentBridgeCwd: string;
}
interface OfficialProject {
  id: string;
  name: string;
  roots: string[];
  lastActive?: number;
  ownerHash?: string;
}
export interface WorkspaceEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  size?: number;
  modifiedAt?: number;
  accessible: boolean;
}
export interface WorkspaceInspection {
  workspaceId: string;
  workspaceName: string;
  path: string;
  relativePath: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

const CACHE_MS = 60_000;
const MAX_PAGES = 100;
const MAX_ENTRIES = 200;
const MAX_LIST_WORKSPACES = 25;
const MAX_LIST_BODY = 2900;
function identity(directory: string) {
  const normalized = path.normalize(directory);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function workspaceId(directory: string) {
  return (
    "ws-" +
    createHash("sha256").update(identity(directory)).digest("hex").slice(0, 20)
  );
}
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return undefined;
  // The official thread API uses Unix seconds; tolerate millisecond fixtures/older adapters.
  return value < 100_000_000_000 ? value * 1000 : value;
}
function projectLabels(snapshot: WorkspaceSnapshot): Map<string, string> {
  const clean = (name: string) => name.replace(/[\r\n\t]+/g, " ").trim();
  const labels = new Map(
    snapshot.projects.map((project) => [project.id, clean(project.name)]),
  );
  const groups = new Map<string, WorkspaceProject[]>();
  for (const project of snapshot.projects) {
    const key = clean(project.name).normalize("NFKC").toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  const parents = (project: WorkspaceProject, depth: number) => {
    const result = new Set<string>();
    for (const id of project.workspaceIds) {
      const workspace = snapshot.workspaces.find((entry) => entry.id === id);
      if (!workspace) continue;
      let parent = workspace.path;
      for (let level = 0; level < depth; level++) parent = path.dirname(parent);
      const name = clean(path.basename(parent));
      if (name) result.add(name);
    }
    return [...result];
  };
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const [index, project] of group.entries()) {
      let qualifier: string | undefined;
      for (let depth = 1; depth <= 12 && !qualifier; depth++) {
        qualifier = parents(project, depth)
          .filter((candidate) =>
            group.every(
              (other) =>
                other.id === project.id ||
                !parents(other, depth).includes(candidate),
            ),
          )
          .sort(
            (a, b) => a.length - b.length || a.localeCompare(b, "zh-CN"),
          )[0];
      }
      labels.set(
        project.id,
        `${clean(project.name)}（${qualifier ?? `项目 ${index + 1}`}）`,
      );
    }
  }
  return labels;
}

/** Reads workspace metadata through the public App Server API, never private Codex files. */
export class WorkspaceCatalog {
  private discovered: Workspace[] = [];
  private officialProjects: OfficialProject[] = [];
  private error?: string;
  private updatedAt?: number;
  private lastAttemptAt?: number;
  private refreshing?: Promise<WorkspaceSnapshot>;
  constructor(
    private codex: CodexController,
    private config: Config,
    private registered: () => Project[],
    private currentOwner?: () => string,
  ) {}

  private excluded(directory: string): boolean {
    // Test/smoke instances can use another dataDir while their isolated sessions
    // remain visible in the same Codex account's history.
    const components = path.normalize(directory).split(path.sep);
    if (
      components.some(
        (part) =>
          /^(?:qa-workspace|\.codex)$/i.test(part) ||
          /^referenced-chatgpt-conversation-/i.test(part),
      ) ||
      components.some(
        (part, index) =>
          /^test-output$/i.test(part) &&
          /^(?:computer|chat)-smoke$/i.test(components[index + 1] ?? ""),
      ) ||
      within(path.join(process.cwd(), "test-output"), directory)
    )
      return true;
    const configured = path.resolve(this.config.dataDir);
    if (within(configured, directory)) return true;
    try {
      return within(realpathSync.native(configured), directory);
    } catch {
      return false;
    }
  }
  private existing(directory: unknown): string | undefined {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) return;
    try {
      const resolved = canonicalProject(directory);
      if (
        this.currentOwner &&
        within(path.resolve(this.config.projectCreationRoot), resolved)
      ) {
        const owner = this.currentOwner();
        const ownRoot = path.join(
          path.resolve(this.config.projectCreationRoot),
          createHash("sha256").update(owner).digest("hex").slice(0, 16),
        );
        if (!owner || !within(ownRoot, resolved)) return;
      }
      if (!this.excluded(resolved)) return resolved;
    } catch {
      // Historical sessions may point to deleted/unmounted directories.
    }
  }
  /** Scope desktop observations to the connected account and current Bridge owner. */
  observationScope(thread: { cwd?: unknown; projectId?: unknown }) {
    const directory = this.existing(thread.cwd);
    if (!directory) return;
    const owner = this.currentOwner?.() ?? "";
    if (!owner) return;
    const hash = createHash("sha256").update(owner).digest("hex");
    const matches = this.officialProjects.filter((p) =>
      p.roots.some((root) => identity(root) === identity(directory)),
    );
    if (thread.projectId != null) {
      const exact = matches.find((p) => p.id === thread.projectId);
      if (!exact || (exact.ownerHash && exact.ownerHash !== hash)) return;
      return { cwd: directory, projectId: exact.id, projectName: exact.name };
    }
    // An unassigned desktop conversation must not borrow a foreign project's root.
    if (matches.some((p) => p.ownerHash && p.ownerHash !== hash)) return;
    return {
      cwd: directory,
      ...(matches.length === 1
        ? { projectId: matches[0]!.id, projectName: matches[0]!.name }
        : { projectName: path.basename(directory) }),
    };
  }
  snapshot(): WorkspaceSnapshot {
    const merged = new Map<string, Workspace>();
    for (const workspace of this.discovered) {
      const existing = this.existing(workspace.path);
      if (existing && identity(existing) === identity(workspace.path))
        merged.set(identity(existing), { ...workspace });
    }
    for (const project of this.registered()) {
      const directory = this.existing(project.path);
      // Registered paths were canonicalized when authorized. A replaced root junction
      // must not silently transfer that authorization to another directory.
      if (
        !directory ||
        identity(directory) !== identity(path.resolve(project.path))
      )
        continue;
      const key = identity(directory);
      const prior = merged.get(key);
      merged.set(key, {
        id: workspaceId(directory),
        name: project.name,
        path: directory,
        source: prior ? "registered+codex" : "registered",
        ...(prior?.lastActive ? { lastActive: prior.lastActive } : {}),
        registered: true,
      });
    }
    const projects: WorkspaceProject[] = [];
    const official = new Map(this.officialProjects.map((p) => [p.id, p]));
    // A confirmed create response is official evidence, even before list pagination catches up.
    for (const p of this.registered())
      if (p.creationId && p.codexProjectId && !official.has(p.codexProjectId))
        official.set(p.codexProjectId, {
          id: p.codexProjectId,
          name: p.name,
          roots: [p.path],
        });
    for (const project of official.values()) {
      if (
        project.ownerHash &&
        this.currentOwner &&
        project.ownerHash !==
          createHash("sha256").update(this.currentOwner()).digest("hex")
      )
        continue;
      const workspaceIds: string[] = [];
      for (const root of project.roots) {
        const directory = this.existing(root);
        if (!directory || identity(directory) !== identity(root)) continue;
        const key = identity(directory);
        const prior = merged.get(key);
        const ids = [...new Set([...(prior?.projectIds ?? []), project.id])];
        const names = [
          ...new Set([...(prior?.projectNames ?? []), project.name]),
        ];
        const lastActive = Math.max(
          prior?.lastActive ?? 0,
          project.lastActive ?? 0,
        );
        const workspace: Workspace = {
          id: workspaceId(directory),
          name: prior?.projectIds?.length ? prior.name : project.name,
          path: directory,
          source: prior?.registered ? "registered+codex" : "codex",
          registered: prior?.registered ?? false,
          projectIds: ids,
          projectNames: names,
          ...(lastActive ? { lastActive } : {}),
        };
        merged.set(key, workspace);
        workspaceIds.push(workspace.id);
      }
      // A real project still exists when its roots are private, offline or absent.
      projects.push({
        id: project.id,
        name: project.name,
        workspaceIds: [...new Set(workspaceIds)],
        source: "codex",
        ...(project.lastActive ? { lastActive: project.lastActive } : {}),
      });
    }
    for (const workspace of merged.values()) {
      if (!workspace.projectIds?.length)
        projects.push({
          id: workspace.id,
          name: workspace.name,
          workspaceIds: [workspace.id],
          source: "workspace",
          ...(workspace.lastActive ? { lastActive: workspace.lastActive } : {}),
        });
    }
    return {
      workspaces: [...merged.values()].sort(
        (a, b) =>
          (b.lastActive ?? 0) - (a.lastActive ?? 0) ||
          a.name.localeCompare(b.name, "zh-CN") ||
          a.path.localeCompare(b.path),
      ),
      projects,
      ...(this.error ? { error: this.error } : {}),
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      currentBridgeCwd: process.cwd(),
    };
  }
  async refresh(force = false): Promise<WorkspaceSnapshot> {
    if (this.refreshing) return this.refreshing;
    if (
      !force &&
      this.lastAttemptAt !== undefined &&
      Date.now() - this.lastAttemptAt < CACHE_MS
    )
      return this.snapshot();
    this.lastAttemptAt = Date.now();
    const pending = this.discover();
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = undefined;
    }
  }
  private async discover(): Promise<WorkspaceSnapshot> {
    if (!this.codex.connected) {
      this.error = "Codex 当前未连接";
      return this.snapshot();
    }
    const results = await Promise.allSettled([
      this.readProjects(),
      this.readThreads(),
    ]);
    const errors: string[] = [];
    const official = results[0];
    const threads = results[1];
    if (official.status === "fulfilled") this.officialProjects = official.value;
    else
      errors.push(
        safeText(
          official.reason instanceof Error
            ? official.reason.message
            : official.reason,
          150,
        ),
      );
    if (threads.status === "fulfilled") this.discovered = threads.value;
    else
      errors.push(
        safeText(
          threads.reason instanceof Error
            ? threads.reason.message
            : threads.reason,
          150,
        ),
      );
    if (!errors.length) this.updatedAt = Date.now();
    this.error = errors.length ? [...new Set(errors)].join("；") : undefined;
    return this.snapshot();
  }
  private async readProjects(): Promise<OfficialProject[]> {
    const projects = new Map<string, OfficialProject>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Error("项目记录较多，本次查询未完成");
      const response = await this.codex.request<{
        data: {
          id?: unknown;
          name?: unknown;
          roots?: { path?: unknown }[];
          recencyAt?: unknown;
          updatedAt?: unknown;
          metadata?: { bridgeOwner?: unknown };
        }[];
        nextCursor?: string | null;
      }>("project/list", {
        limit: 100,
        sortKey: "position",
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(response.data))
        throw new Error("Codex 返回的项目列表无效");
      for (const project of response.data) {
        if (
          typeof project.id !== "string" ||
          typeof project.name !== "string" ||
          !project.name.trim() ||
          !Array.isArray(project.roots)
        )
          continue;
        const roots = project.roots
          .map((root) => this.existing(root.path))
          .filter((root): root is string => !!root);
        const lastActive =
          timestamp(project.recencyAt) ?? timestamp(project.updatedAt);
        projects.set(project.id, {
          id: project.id,
          name: project.name,
          roots: [...new Set(roots)],
          ...(typeof project.metadata?.bridgeOwner === "string"
            ? { ownerHash: project.metadata.bridgeOwner }
            : {}),
          ...(lastActive ? { lastActive } : {}),
        });
      }
      if (response.nextCursor == null || response.nextCursor === "") break;
      if (
        typeof response.nextCursor !== "string" ||
        cursors.has(response.nextCursor)
      )
        throw new Error("Codex 项目分页未正常结束");
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    return [...projects.values()];
  }
  private async readThreads(): Promise<Workspace[]> {
    const found = new Map<string, Workspace>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES)
        throw new Error("工作目录记录较多，本次查询未完成");
      const response = await this.codex.request<{
        data: { cwd?: unknown; updatedAt?: unknown; createdAt?: unknown }[];
        nextCursor?: string | null;
      }>("thread/list", {
        limit: 100,
        modelProviders: [],
        sortKey: "updated_at",
        sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(response.data))
        throw new Error("Codex 返回的工作目录列表无效");
      for (const thread of response.data) {
        const directory = this.existing(thread.cwd);
        if (!directory) continue;
        const key = identity(directory);
        const lastActive =
          timestamp(thread.updatedAt) ?? timestamp(thread.createdAt);
        const prior = found.get(key);
        if (prior) {
          if (lastActive && lastActive > (prior.lastActive ?? 0))
            prior.lastActive = lastActive;
        } else {
          found.set(key, {
            id: workspaceId(directory),
            name: path.basename(directory),
            path: directory,
            source: "codex",
            registered: false,
            ...(lastActive ? { lastActive } : {}),
          });
        }
      }
      if (response.nextCursor == null || response.nextCursor === "") break;
      if (
        typeof response.nextCursor !== "string" ||
        cursors.has(response.nextCursor)
      )
        throw new Error("Codex 工作目录分页未正常结束");
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    return [...found.values()];
  }
  async list(): Promise<string> {
    const snapshot = await this.refresh();
    const labels = projectLabels(snapshot);
    const lines: string[] = [];
    let bodyLength = 0;
    for (const project of snapshot.projects.slice(0, MAX_LIST_WORKSPACES)) {
      let line = `${lines.length + 1}. ${labels.get(project.id)}`;
      if (!lines.length && line.length > MAX_LIST_BODY)
        line = `1. ${project.name.slice(0, 100)}…（名称较长，未完整展开）`;
      if (bodyLength + line.length + 1 > MAX_LIST_BODY) break;
      lines.push(line);
      bodyLength += line.length + 1;
    }
    const remaining = snapshot.projects.length - lines.length;
    const tail = remaining
      ? `\n另有 ${remaining} 个项目未展示，可指定项目名继续查询。`
      : "";
    if (snapshot.error) {
      return (
        "这次未能更新项目列表。" +
        (lines.length
          ? `\n目前已知的项目：\n${lines.join("\n")}${tail}`
          : "\n暂时无法确认有哪些项目，连接恢复后可以再查询。")
      );
    }
    return lines.length
      ? `你的项目：\n${lines.join("\n")}${tail}`
      : "暂时没有找到项目。";
  }

  /** Resolve a catalog directory without allowing absolute paths, traversal or junction escape. */
  resolveDirectory(
    id: string,
    relativePath = "",
  ): { workspace: Workspace; path: string } {
    const workspace = this.snapshot().workspaces.find(
      (entry) => entry.id === id,
    );
    if (!workspace) throw new Error("没有找到这个工作目录，请重新查询项目列表");
    if (
      typeof relativePath !== "string" ||
      relativePath.length > 4096 ||
      relativePath.includes("\0") ||
      path.isAbsolute(relativePath)
    )
      throw new Error("请提供工作目录内的相对路径");
    const target = path.resolve(workspace.path, relativePath);
    if (!within(workspace.path, target))
      throw new Error("不能访问工作目录之外的路径");
    const root = realpathSync.native(workspace.path);
    if (identity(root) !== identity(workspace.path))
      throw new Error("工作目录位置已改变，请重新查询");
    const resolved = realpathSync.native(target);
    if (!within(root, resolved) || this.excluded(resolved))
      throw new Error("不能访问工作目录之外或 Bridge 数据目录中的路径");
    if (!statSync(resolved).isDirectory()) throw new Error("这个路径不是目录");
    return { workspace, path: resolved };
  }
  inspect(id: string, relativePath = ""): WorkspaceInspection {
    const resolved = this.resolveDirectory(id, relativePath);
    const names = readdirSync(resolved.path).sort((a, b) =>
      a.localeCompare(b, "zh-CN"),
    );
    const entries = names.slice(0, MAX_ENTRIES).map((name): WorkspaceEntry => {
      const child = path.join(resolved.path, name);
      try {
        const info = lstatSync(child);
        const type = info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "directory"
            : info.isFile()
              ? "file"
              : "other";
        let accessible = false;
        try {
          const actual = realpathSync.native(child);
          accessible =
            within(resolved.workspace.path, actual) && !this.excluded(actual);
        } catch {
          // Broken links and inaccessible entries remain visible, without following them.
        }
        return {
          name,
          type,
          ...(info.isFile() ? { size: info.size } : {}),
          modifiedAt: info.mtimeMs,
          accessible,
        };
      } catch {
        return { name, type: "other", accessible: false };
      }
    });
    return {
      workspaceId: resolved.workspace.id,
      workspaceName: resolved.workspace.name,
      path: resolved.path,
      relativePath: path.relative(resolved.workspace.path, resolved.path),
      entries,
      truncated: names.length > MAX_ENTRIES,
    };
  }
}
