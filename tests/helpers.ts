import { Store } from "../src/storage/store.js";
import { MockCodex } from "../src/codex/mock.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";
import { TodoManager } from "../src/scheduler/todos.js";
import { MessageRouter } from "../src/app/router.js";
import { loadConfig } from "../src/app/config.js";
export async function fixture() {
  const config = loadConfig("nonexistent.json");
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
    router = new MessageRouter(store, tasks, todos, notices, config);
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
    project,
  };
}
