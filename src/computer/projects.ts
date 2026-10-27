import path from "node:path";
import type { TaskOrchestrator } from "../tasks/orchestrator.js";
import type { WorkspaceCatalog } from "./workspaces.js";

/** Binding establishes the caller; discovered IDs establish the target, without a second grant. */
export async function executionProject(
  tasks: TaskOrchestrator,
  catalog: WorkspaceCatalog | undefined,
  idOrName: string,
) {
  const owner = tasks.store.setting("boundUser", "");
  if (!owner) throw new Error("请先完成首次微信扫码绑定");
  const existingMatches = tasks
    .projects()
    .filter(
      (project) =>
        project.id === idOrName ||
        project.codexProjectId === idOrName ||
        project.name === idOrName,
    );
  if (existingMatches.length > 1)
    throw new Error("有多个同名项目，请说明要操作哪一个");
  const existing = existingMatches[0];
  const exactId =
    existing &&
    (existing.id === idOrName || existing.codexProjectId === idOrName);
  if (existing && (!catalog || exactId)) return tasks.project(existing.id);
  if (!catalog) throw new Error("没有找到这个项目，请说明项目名称");
  const snapshot = await catalog.refresh();
  if (tasks.store.setting("boundUser", "") !== owner)
    throw new Error("微信绑定已改变，本次操作未执行");
  const formal = snapshot.projects.filter(
    (p) => p.id === idOrName || p.name === idOrName,
  );
  if (formal.length > 1) throw new Error("有多个同名项目，请说明要处理哪一个");
  if (existing && !formal.length) {
    if (snapshot.error)
      throw new Error("当前无法核实项目名称是否唯一，请用项目 ID 指定");
    return tasks.project(existing.id);
  }
  const matches = formal.length
    ? snapshot.workspaces.filter((w) => formal[0]!.workspaceIds.includes(w.id))
    : snapshot.workspaces.filter(
        (w) => w.id === idOrName || w.name === idOrName,
      );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "这个项目包含多个工作目录，请说明本次要处理哪一个"
        : "没有找到这个项目当前可用的本地目录",
    );
  const workspace = matches[0]!;
  const samePath = tasks
    .projects()
    .find((p) => p.path.toLowerCase() === workspace.path.toLowerCase());
  if (samePath) {
    if (formal[0]?.source === "codex") {
      samePath.codexProjectId = formal[0].id;
      tasks.store.put("projects", samePath);
    }
    return tasks.project(samePath.id);
  }
  let name = formal[0]?.name ?? workspace.projectNames?.[0] ?? workspace.name;
  name = name.slice(0, 65);
  if (tasks.projects().some((p) => p.name === name))
    name = `${name.slice(0, 45)}（${path.basename(path.dirname(workspace.path)).slice(0, 15)}-${workspace.id.slice(-6)}）`;
  const project = tasks.addProject(name, workspace.path);
  if (formal[0]?.source === "codex") {
    project.codexProjectId = formal[0].id;
    tasks.store.put("projects", project);
  }
  return project;
}
