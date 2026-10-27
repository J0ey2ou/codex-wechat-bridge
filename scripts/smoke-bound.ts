import path from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { AppServerClient, appServerArgs } from "../src/codex/client.js";
import { Store } from "../src/storage/store.js";
import { loadConfig } from "../src/app/config.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";
import type { Task, Approval } from "../src/app/types.js";

const config = loadConfig();
config.executionAuthorization = "bound-user";
const base = path.resolve("test-output/bound-smoke");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(path.join(base, "project-"));
const store = new Store(":memory:");
store.setSetting("boundUser", "smoke");
const codex = new AppServerClient(
  config.codexBin,
  appServerArgs(config.codexTransport),
);
const notices = new NotificationManager(store, new MockWeChat());
const tasks = new TaskOrchestrator(store, codex, notices, config);
const report: Record<string, unknown> = {
  kind: "REAL_CODEX_BOUND_USER_WORKSPACE_WRITE",
  directory,
};
let requestedApprovals = 0;
codex.onEvent((event) => {
  if (event.id !== undefined) requestedApprovals++;
});
try {
  await codex.connect();
  const project = tasks.addProject("隔离执行验证", directory);
  const task = tasks.create(
    project.id,
    "只在本项目目录新建 verification.txt，内容精确为 bridge-bound-user-ok。完成后读取此文件验证内容；不改其他文件，不访问网络。无需解释计划，执行后按结果汇报。",
  );
  await tasks.pump();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const current = store.get<Task>("tasks", task.id)!;
    if (
      ["COMPLETED", "FAILED", "INTERRUPTED", "UNKNOWN"].includes(current.status)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await tasks.drained();
  const current = store.get<Task>("tasks", task.id)!;
  const file = path.join(directory, "verification.txt");
  Object.assign(report, {
    status: current.status,
    summary: current.summary,
    error: current.error,
    requestedApprovals,
    approvalRecords: store.all<Approval>("approvals").length,
    fileExists: existsSync(file),
    contentMatches:
      existsSync(file) &&
      readFileSync(file, "utf8").trim() === "bridge-bound-user-ok",
  });
  report.passed =
    current.status === "COMPLETED" &&
    report.contentMatches &&
    requestedApprovals === 0 &&
    report.approvalRecords === 0;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await codex.disconnect();
  await tasks.drained();
  writeFileSync("test-output/real-bound.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  store.close();
}
