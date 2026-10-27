import { AppServerClient, appServerArgs } from "../src/codex/client.js";
import { Store } from "../src/storage/store.js";
import { loadConfig } from "../src/app/config.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";
import { TodoManager } from "../src/scheduler/todos.js";
import { IntentDispatcher } from "../src/app/intent.js";
import { QuestionManager, type Question } from "../src/codex/questions.js";
import { WorkspaceCatalog } from "../src/computer/workspaces.js";
import { ComputerService } from "../src/computer/service.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Explicit opt-in to visible launch: --open. No real WeChat delivery or business-data writes.
const config = loadConfig();
config.dataDir = path.resolve("test-output/computer-smoke");
const store = new Store(":memory:");
store.setSetting("boundUser", "smoke");
const codex = new AppServerClient(
  config.codexBin,
  appServerArgs(config.codexTransport),
);
const notices = new NotificationManager(store, new MockWeChat());
const tasks = new TaskOrchestrator(store, codex, notices, config);
const todos = new TodoManager(store, notices, config);
const computer = new ComputerService(
  new WorkspaceCatalog(codex, config, () => tasks.projects()),
);
const dispatcher = new IntentDispatcher(
  store,
  tasks,
  todos,
  codex,
  config,
  computer,
);
const questions = new QuestionManager(
  store,
  codex,
  notices,
  config,
  dispatcher,
);
const results: unknown[] = [];
try {
  await codex.connect();
  await computer.prepare();
  console.log(
    "Discovered workspaces:",
    computer.workspaces.snapshot().workspaces.length,
  );
  const cases = process.argv.includes("--open")
    ? ["打开 ddl-app，查询一下我今天的待办事项"]
    : ["我的工作项目有哪些", "根据ddl，我今天的待办任务有哪些"];
  for (const [i, text] of cases.entries()) {
    const id = `computer-${i}`;
    questions.enqueue(text, "smoke", id);
    await questions.pump();
    const deadline = Date.now() + 370000;
    let observed = 0;
    while (Date.now() < deadline) {
      questions.monitor();
      const q = store.get<Question>("questions", id)!;
      for (const call of (q.toolCalls ?? []).slice(observed)) {
        console.log(
          "Tool:",
          call.request,
          "result:",
          (call.result as any)?.error ?? "received",
        );
      }
      observed = q.toolCalls?.length ?? 0;
      if (["completed", "failed"].includes(q.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await questions.drained();
    const q = store.get<Question>("questions", id)!;
    const passed =
      q.status === "completed" &&
      (i === 0 && !process.argv.includes("--open")
        ? q.answer?.includes("ddl-app") &&
          !/[A-Z]:[\\/]|授权|注册/.test(q.answer) &&
          computer.workspaces
            .snapshot()
            .projects.some(
              (p) => p.name !== "ddl-app" && q.answer?.includes(p.name),
            )
        : q.toolCalls?.some(
            (c) =>
              JSON.parse(c.request).tool === "database_query" &&
              Array.isArray((c.result as any)?.rows),
          ));
    results.push({
      text,
      status: q.status,
      answer: q.answer,
      error: q.error,
      toolCalls: q.toolCalls,
      durationMs: (q.endedAt ?? Date.now()) - q.createdAt,
      passed,
    });
    console.log(
      JSON.stringify({
        case: i,
        status: q.status,
        steps: q.toolCalls?.length ?? 0,
        answer: q.answer,
        passed,
      }),
    );
    if (!passed) process.exitCode = 1;
  }
  if (tasks.tasks().length || todos.list().length)
    throw new Error("Read-only query unexpectedly created a task/todo");
  if (
    store
      .all<any>("notification_deliveries")
      .some((d) => d.dedupeKey.startsWith("answer-wait:"))
  )
    throw new Error("Unexpected canned progress notice");
} catch (error) {
  results.push({ error: String(error) });
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await codex.disconnect();
  await questions.drained();
  mkdirSync("test-output", { recursive: true });
  writeFileSync(
    "test-output/real-computer.json",
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        kind: "REAL_MODEL_LOCAL_READ_MOCK_WECHAT",
        results,
      },
      null,
      2,
    ),
  );
  store.close();
}
