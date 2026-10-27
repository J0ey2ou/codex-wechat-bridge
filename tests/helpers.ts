import { Store } from "../src/storage/store.js";
import { MockCodex } from "../src/codex/mock.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";
import { TodoManager } from "../src/scheduler/todos.js";
import { MessageRouter } from "../src/app/router.js";
import { loadConfig } from "../src/app/config.js";
import { QuestionManager, type Question } from "../src/codex/questions.js";
import { IntentDispatcher, type Intent } from "../src/app/intent.js";
import type { ComputerService } from "../src/computer/service.js";
export async function fixture(computer?: ComputerService) {
  const config = loadConfig("nonexistent.json");
  config.executionAuthorization = "per-action";
  config.collectionMinutes = 0;
  const store = new Store(":memory:"),
    codex = new MockCodex(),
    channel = new MockWeChat();
  await codex.connect();
  await channel.connect();
  store.setSetting("boundUser", "owner");
  const notices = new NotificationManager(store, channel),
    tasks = new TaskOrchestrator(store, codex, notices, config),
    todos = new TodoManager(store, notices, config),
    dispatcher = new IntentDispatcher(
      store,
      tasks,
      todos,
      codex,
      config,
      computer,
    ),
    questions = new QuestionManager(store, codex, notices, config, dispatcher),
    router = new MessageRouter(store, tasks, todos, notices, config, questions);
  async function decide(id: string, intent: Partial<Intent>) {
    await questions.pump();
    const q = store.get<Question>("questions", id)!;
    const plan: Intent = {
      action: "answer",
      reply: "回答",
      computer: null,
      projectId: null,
      taskId: null,
      todoId: null,
      approvalId: null,
      text: null,
      date: null,
      repeatMinutes: null,
      newProject: null,
      ...intent,
    };
    codex.emit("item/completed", {
      threadId: q.threadId,
      turnId: q.turnId,
      item: { type: "agentMessage", text: JSON.stringify(plan) },
    });
    codex.emit("turn/completed", {
      threadId: q.threadId,
      turn: { id: q.turnId, status: "completed" },
    });
    await questions.drained();
    await tasks.drained();
    return store.get<Question>("questions", id)!;
  }
  const project = tasks.addProject("项目", process.cwd());
  return {
    config,
    store,
    codex,
    channel,
    notices,
    tasks,
    todos,
    router,
    dispatcher,
    questions,
    decide,
    project,
  };
}
