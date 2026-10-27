import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { AppServerClient } from "../src/codex/client.js";
import { CodexVisibility } from "../src/codex/visibility.js";
import { loadConfig } from "../src/app/config.js";

// Backfill public thread metadata only. Never resume, replay, or stop live work.
const config = loadConfig();
const db = new DatabaseSync(path.join(config.dataDir, "bridge.sqlite"), { readOnly: true });
const client = new AppServerClient(config.codexBin);
const visible = new CodexVisibility(client);
const apply = process.argv.includes("--apply");
try {
  const ownerRow = db.prepare("SELECT data FROM application_settings WHERE id='boundUser'").get();
  const owner = ownerRow && JSON.parse(String(ownerRow.data)).value;
  if (!owner) throw new Error("没有当前绑定用户，未修改会话");
  const rows = (table: "questions" | "tasks" | "projects") => db.prepare(`SELECT data FROM ${table} ORDER BY updated_at DESC`).all()
    .map(row => JSON.parse(String(row.data)))
    .filter(row => table === "questions" ? row.userId === owner : row.ownerId === undefined || row.ownerId === owner);
  const projects = rows("projects");
  const seen = new Set<string>();
  await client.connect();
  for (const task of rows("tasks")) {
    if (!task.threadId || seen.has(task.threadId)) continue;
    seen.add(task.threadId);
    const project = projects.find(p => p.id === task.projectId);
    if (!project) continue;
    const before = await client.request("thread/read", { threadId: task.threadId });
    if (apply) {
      const projectId = await visible.ensureProject(project);
      await visible.attachThread(task.threadId, projectId);
      if (!before.thread?.name) await visible.setName(task.threadId, `微信任务 · ${project.name}`);
    }
    const result = await client.request("thread/read", { threadId: task.threadId });
    console.log(JSON.stringify({ kind: "project", threadId: task.threadId, name: result.thread?.name, projectId: result.thread?.projectId, bridgeStatus: task.status }));
  }
  const questions = rows("questions");
  const qaIds = [...new Set(questions.map(q => q.threadId).filter(Boolean))];
  const qaProjectId = apply && qaIds.length
    ? await visible.ensureProject({ id: "bridge-questions", name: "鲁滨逊", path: process.cwd() })
    : undefined;
  for (const [index, threadId] of qaIds.entries()) {
    const before = await client.request("thread/read", { threadId });
    if (qaProjectId) await visible.attachThread(threadId, qaProjectId);
    if (apply && !before.thread?.name)
      await visible.setName(threadId, index === 0 ? "微信问答 · 鲁滨逊" : `微信问答 · 历史 ${index}`);
    const result = await client.request("thread/read", { threadId });
    console.log(JSON.stringify({ kind: "question", threadId, name: result.thread?.name, projectId: result.thread?.projectId }));
  }
} finally {
  db.close();
  await client.disconnect();
}
