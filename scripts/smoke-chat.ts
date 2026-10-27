import { AppServerClient, appServerArgs } from "../src/codex/client.js";
import { Store } from "../src/storage/store.js";
import { loadConfig } from "../src/app/config.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";
import { TodoManager } from "../src/scheduler/todos.js";
import { IntentDispatcher } from "../src/app/intent.js";
import { QuestionManager, type Question } from "../src/codex/questions.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const config = loadConfig();
config.dataDir = path.resolve("test-output/chat-smoke");
const store = new Store(":memory:");
store.setSetting("boundUser", "smoke");
const c = new AppServerClient(
  config.codexBin,
  appServerArgs(config.codexTransport),
);
const request = c.request.bind(c);
c.request = async (method, params) => {
  const result = await request(method, params);
  if (method === "thread/start")
    console.log(
      "Runtime:",
      JSON.stringify({ model: result.model, provider: result.modelProvider }),
    );
  return result;
};
const notices = new NotificationManager(store, new MockWeChat());
const tasks = new TaskOrchestrator(store, c, notices, config);
const todos = new TodoManager(store, notices, config);
const dispatcher = new IntentDispatcher(store, tasks, todos, c, config);
const questions = new QuestionManager(store, c, notices, config, dispatcher);
const projectPath = path.join(config.dataDir, "test-project");
mkdirSync(projectPath, { recursive: true });
tasks.addProject("桥接验证", projectPath);
const report: Record<string, unknown> = {
  kind: "REAL_CODEX_MODEL_MOCK_DELIVERY",
  startedAt: new Date().toISOString(),
  cases: [],
};
const eventCounts: Record<string, number> = {};
c.onEvent((e) => {
  eventCounts[e.method] = (eventCounts[e.method] ?? 0) + 1;
  if (e.method === "error")
    console.log("Codex error:", JSON.stringify(e.params.error));
  if (e.method === "mcpServer/startupStatus/updated")
    console.log("Tool startup:", e.params.name, e.params.status);
});
try {
  await c.connect();
  report.handshake = true;
  console.log("Real model connected; checking first message...");
  const cases = [
    ["qa", "用一句话解释什么是 token", "answer"],
    ["followup", "再举个简单例子", "answer"],
    ["account", "我还有多少token", "account"],
    ["question", "任务状态机怎么理解", "answer"],
    ["work", "帮我检查桥接验证项目的代码，不运行命令也不要改文件", "run"],
    ["reminder", "明天下午提醒我交报告", "add_todo"],
    ["time", "下午三点", "add_todo"],
  ];
  for (const [id, text, expected] of cases) {
    questions.enqueue(text!, "smoke", id!);
    await questions.pump();
    const deadline = Date.now() + 95000;
    while (Date.now() < deadline) {
      questions.monitor();
      const q = store.get<Question>("questions", id!)!;
      if (["completed", "failed"].includes(q.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await questions.drained();
    const q = store.get<Question>("questions", id!)!;
    const passed =
      q.status === "completed" &&
      (q.decision?.action === expected ||
        (id === "reminder" && q.decision?.action === "answer"));
    const item = {
      id,
      expected,
      action: q.decision?.action,
      status: q.status,
      answer: q.answer,
      error: q.error,
      durationMs: (q.endedAt ?? Date.now()) - q.createdAt,
      passed,
    };
    (report.cases as unknown[]).push(item);
    console.log(JSON.stringify(item));
    if (!item.passed) {
      process.exitCode = 1;
      break;
    }
  }
  report.tasksCreated = tasks.tasks().length;
  report.todosCreated = todos.list().length;
} catch (e) {
  report.error = String(e);
  process.exitCode = 1;
} finally {
  report.events = eventCounts;
  await c.disconnect();
  await questions.drained();
  mkdirSync("test-output", { recursive: true });
  writeFileSync("test-output/real-chat.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
