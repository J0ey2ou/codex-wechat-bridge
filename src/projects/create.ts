import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Config } from "../app/config.js";
import type { CodexController, Project } from "../app/types.js";
import {
  CodexVisibility,
  officialProject,
  type OfficialProject,
} from "../codex/visibility.js";
import { modelIdentifier, requireModel } from "../codex/models.js";
import { Store } from "../storage/store.js";
import { TaskOrchestrator } from "../tasks/orchestrator.js";
import { within } from "../security/policy.js";

export interface NewProjectRequest {
  name: string | null;
  directory: string | null;
  initialTask: string | null;
  model: string | null;
}
interface Creation {
  id: string;
  messageId?: string;
  name: string;
  directory: string;
  initialTask: string | null;
  requestedModel: string | null;
  model: string | null;
  localProjectId: string;
  state: "reserved" | "directory" | "submitted" | "complete" | "failed";
  official?: OfficialProject;
  taskId?: string;
  createdAt: number;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const nameKey = (s: string) => s.normalize("NFKC").toLowerCase();
const samePath = (a: string, b: string) =>
  process.platform === "win32"
    ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase()
    : path.normalize(a) === path.normalize(b);
const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};

/** Only this service creates directories. A local directory is never a formal project. */
export class ProjectCreator {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    private tasks: TaskOrchestrator,
    private codex: CodexController,
    private config: Config,
  ) {}

  private owner(user: string) {
    if (!user || this.store.setting("boundUser", "") !== user)
      throw new Error("微信绑定已改变，本次未继续创建项目。");
  }

  defaultRoot(user: string) {
    return path.join(
      path.resolve(this.config.projectCreationRoot),
      hash(user).slice(0, 16),
    );
  }

  create(
    request: NewProjectRequest,
    user: string,
    messageId: string,
  ): Promise<string> {
    const run = this.tail.then(() => this.perform(request, user, messageId));
    this.tail = run.catch(() => {});
    return run;
  }

  private target(request: NewProjectRequest, user: string) {
    const root = this.defaultRoot(user);
    const target = path.resolve(root, request.directory || request.name!);
    const workspace = realpathSync.native(process.cwd());
    if (
      !within(workspace, root) ||
      samePath(workspace, root) ||
      !within(root, target) ||
      samePath(root, target)
    )
      throw new Error(
        `新项目目录必须位于当前用户的创建目录 ${root} 内，可提供相对目录。`,
      );
    for (const blocked of [
      this.config.dataDir,
      path.join(workspace, "test-output"),
    ])
      if (within(path.resolve(blocked), target))
        throw new Error("不能在 Bridge 数据或测试输出目录内创建项目。");
    const parts = path.relative(workspace, target).split(path.sep);
    if (
      parts.some(
        (p) =>
          !p ||
          p.length > 100 ||
          /[<>:"|?*\x00-\x1f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) ||
          /^(?:\.git|\.codex|\.agents|\.aws|qa-workspace|secrets)$/i.test(p),
      )
    )
      throw new Error("项目目录包含保留名称或无效字符，请换一个目录。");
    let current = workspace;
    for (const part of parts) {
      current = path.join(current, part);
      if (!present(current)) continue;
      const info = lstatSync(current);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        !samePath(realpathSync.native(current), current)
      )
        throw new Error("项目路径包含链接或非目录，未创建或覆盖任何项目。");
    }
    return target;
  }

  private matches(p: OfficialProject, op: Creation) {
    return (
      p.name === op.name &&
      p.roots.length === 1 &&
      samePath(p.roots[0]!.path, op.directory)
    );
  }

  private async perform(
    request: NewProjectRequest,
    user: string,
    messageId: string,
  ): Promise<string> {
    this.owner(user);
    if (!request.name?.trim())
      return "新项目叫什么名字？目录可以省略，也可以一起告诉我初始任务和模型。";
    request = {
      ...request,
      name: request.name.trim(),
      directory: request.directory?.trim() || null,
      initialTask: request.initialTask?.trim() || null,
      model: request.model?.trim() || null,
    };
    if (request.name!.length > 80 || /[\x00-\x1f]/.test(request.name!))
      throw new Error("项目名称请控制在 80 个字符内，不含换行。");
    if ((request.initialTask?.length ?? 0) > 8000)
      throw new Error("初始任务过长，请控制在 8000 字符内。");
    const directory = this.target(request, user);
    const model = request.model ? modelIdentifier(request.model) : null;
    const key = "wechat-project-" + hash(JSON.stringify([user, messageId]));
    let op = this.store.get<Creation>("project_creations", key);
    if (!op)
      op = this.store
        .all<Creation>("project_creations")
        .find(
          (o) =>
            (nameKey(o.name) === nameKey(request.name!) ||
              samePath(o.directory, directory)) &&
            o.state !== "complete",
        );
    if (
      op &&
      (op.name !== request.name ||
        !samePath(op.directory, directory) ||
        op.initialTask !== request.initialTask ||
        op.model !== model)
    )
      throw new Error(
        "这个名称已有不同的创建请求；请先核实原请求，或使用其他项目名称和目录。",
      );

    if (!op) {
      // Complete authoritative pagination first. A failing catalog must not mean absence.
      const all = await new CodexVisibility(this.codex).listProjects();
      this.owner(user);
      if (
        all.some((p) => nameKey(p.name) === nameKey(request.name!)) ||
        this.tasks
          .projects()
          .some((p) => nameKey(p.name) === nameKey(request.name!))
      )
        return `已有名为「${request.name}」的项目，未新建或覆盖。请换一个名称，或告诉我继续原项目。`;
      if (
        present(directory) ||
        all.some((p) => p.roots.some((r) => samePath(r.path, directory)))
      )
        return "指定目录已经存在或已属于其他项目，未覆盖。请换一个新目录。";
      if (model) {
        await requireModel(this.codex, model);
        this.owner(user);
      }
      op = {
        id: key,
        messageId,
        name: request.name!,
        directory,
        initialTask: request.initialTask,
        requestedModel: request.model,
        model,
        localProjectId: randomUUID(),
        state: "reserved",
        createdAt: Date.now(),
      };
      const claimed = this.store.transaction(() => {
        if (
          this.store
            .all<Creation>("project_creations")
            .some(
              (o) =>
                o.id === key ||
                nameKey(o.name) === nameKey(request.name!) ||
                samePath(o.directory, directory),
            )
        )
          return false;
        return this.store.insert("project_creations", op!);
      });
      if (!claimed)
        return "同一名称或目录的创建请求已在处理，未重复创建；请稍后查看项目或重发原请求核对结果。";
      try {
        this.target(request, user); // Revalidate after asynchronous calls, before any write.
        mkdirSync(path.dirname(directory), { recursive: true });
        this.target(request, user);
        mkdirSync(directory); // Exclusive leaf creation; never adopt or overwrite an existing folder.
        if (!samePath(realpathSync.native(directory), directory))
          throw new Error("目录位置已改变");
        op.state = "directory";
        this.store.put("project_creations", op);
      } catch {
        op.state = "failed";
        this.store.put("project_creations", op);
        return "本地新目录未能安全创建，未创建正式 Codex 项目。请检查目录权限或换一个名称和目录。";
      }
      op.state = "submitted";
      this.store.put("project_creations", op); // Durable before the remote side effect.
      try {
        const response = await this.codex.request<{ project?: unknown }>(
          "project/create",
          {
            idempotencyKey: op.id,
            name: op.name,
            roots: [{ path: directory }],
            metadata: { bridgeCreationId: op.id, bridgeOwner: hash(user) },
          },
        );
        this.owner(user);
        const created = officialProject(response?.project);
        if (!this.matches(created, op)) throw new Error("创建响应与请求不一致");
        op.official = created;
        this.store.put("project_creations", op);
      } catch (error) {
        this.owner(user);
        if (
          error instanceof Error &&
          /^Codex RPC -32601:/.test(error.message)
        ) {
          op.state = "failed";
          this.store.put("project_creations", op);
          return "当前 Codex 执行端不支持正式项目创建接口。本地目录已建立，但未创建正式项目，也未启动任务。";
        }
        return "本地目录已建立，但未取得匹配的正式 Codex 项目创建结果，不能确认创建成功，也没有启动任务。重复同一请求会先核对官方记录，不会重复创建或覆盖目录。";
      }
    }

    if (!op.official) {
      if (op.state !== "submitted")
        return "此前创建未完成，尚未建立可执行的正式 Codex 项目。原目录不会被覆盖，请换一个名称和目录。";
      const all = await new CodexVisibility(this.codex).listProjects();
      this.owner(user);
      const found = all.filter(
        (p) => p.metadata?.bridgeCreationId === op!.id && this.matches(p, op!),
      );
      if (found.length !== 1)
        return "此前创建结果仍未确认；官方记录中尚未找到唯一匹配项目，未重复创建，也未启动任务。";
      op.official = found[0]!;
      this.store.put("project_creations", op);
    }
    try {
      this.target(request, user);
      if (!present(op.directory)) throw new Error("目录不可用");
    } catch {
      return `Codex 已创建「${op.official.name}」，项目 ID：${op.official.id}，但工作目录校验未通过，未启动任务。`;
    }
    let local = this.store.get<Project>("projects", op.localProjectId);
    if (!local) {
      if (
        this.tasks
          .projects()
          .some(
            (p) =>
              samePath(p.path, op!.directory) ||
              nameKey(p.name) === nameKey(op!.official!.name),
          )
      )
        throw new Error(
          "正式项目已创建，但本地关联发生冲突，未启动任务。请查询项目列表核对。",
        );
      local = {
        id: op.localProjectId,
        name: op.official.name,
        path: op.directory,
        codexProjectId: op.official.id,
        creationId: op.id,
        createdAt: op.createdAt,
        ...(op.model
          ? { requestedModel: op.requestedModel!, executionModel: op.model }
          : {}),
      };
      this.store.put("projects", local);
    }
    if (op.initialTask && !op.taskId) {
      const task = this.tasks.create(
        local.id,
        op.initialTask,
        undefined,
        op.id,
      );
      op.taskId = task.id;
      if (op.messageId) this.tasks.linkMessage(task, op.messageId);
    }
    op.state = "complete";
    this.store.put("project_creations", op);
    return `${this.config.codexMode === "mock" ? "【模拟，未创建真实项目】" : ""}已创建 Codex 项目「${op.official.name}」，项目 ID：${op.official.id}。\n工作目录：${op.directory}。${op.taskId ? "初始任务已排队。" : "可以直接告诉我在这个项目中要做什么。"}${op.model ? `\n指定执行模型：${op.model}；已在执行端目录中核对，账户实际可用性以任务调用结果为准，不会自动换用其他模型。` : ""}`;
  }
}
