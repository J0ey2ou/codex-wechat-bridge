import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { DeliveryUncertainError } from "../src/channels/wechat/ilink.js";
import { loadConfig, validateSettings } from "../src/app/config.js";
import { TodoManager } from "../src/scheduler/todos.js";
import type { Delivery, Reminder, Task, Todo } from "../src/app/types.js";
import { fixture } from "./helpers.js";

async function setup(t: TestContext, defaultEnabled = true) {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "owner");
  t.after(() => store.close());
  const channel = new MockWeChat();
  await channel.connect();
  return {
    store,
    channel,
    notices: new NotificationManager(store, channel, defaultEnabled),
  };
}

function legacy(
  store: Store,
  key: string,
  status: Delivery["status"] = "pending",
) {
  const delivery: Delivery = {
    id: key,
    userId: "owner",
    text: key,
    dedupeKey: key,
    status,
    attempts: status === "sending" ? 1 : 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
    clientVisible: false,
  };
  store.put("notification_deliveries", delivery);
  return delivery;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("WeChat push defaults on and validates only boolean settings", async (t) => {
  const { notices, store, channel } = await setup(t);
  assert.equal(loadConfig("nonexistent.json").wechatPushEnabled, true);
  assert.equal(notices.isPushEnabled(), true);
  assert.doesNotThrow(() => validateSettings({ wechatPushEnabled: false }));
  assert.throws(
    () =>
      validateSettings({ wechatPushEnabled: "false" as unknown as boolean }),
    /布尔/,
  );
  assert.throws(
    () => notices.setPushEnabled("false" as unknown as boolean),
    /布尔/,
  );
  const id = notices.enqueue("主动结果", "finished:default")!;
  assert.equal(
    store.get<Delivery>("notification_deliveries", id)!.kind,
    "notification",
  );
  await notices.flush();
  assert.equal(channel.sent.length, 1);
});

test("push preferences persist across database reopen and override constructor defaults without losing other settings", async (t) => {
  const parent = realpathSync.native(os.tmpdir());
  const directory = mkdtempSync(path.join(parent, "codex-wechat-push-"));
  const file = path.join(directory, "bridge.sqlite");
  let store = new Store(file);
  t.after(() => {
    store.close();
    const resolved = realpathSync.native(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("codex-wechat-push-"));
    rmSync(resolved, { recursive: true, force: true });
  });
  const channel = new MockWeChat();
  store.setSetting("preferences", {
    timezone: "Asia/Shanghai",
    notifyProgress: false,
  });
  let notices = new NotificationManager(store, channel, true);
  notices.setPushEnabled(false);
  store.close();
  store = new Store(file);
  notices = new NotificationManager(store, channel, true);
  assert.equal(notices.isPushEnabled(), false);
  assert.deepEqual(store.setting("preferences", {}), {
    timezone: "Asia/Shanghai",
    notifyProgress: false,
    wechatPushEnabled: false,
  });
  notices.setPushEnabled(true);
  assert.equal(
    new NotificationManager(store, channel, false).isPushEnabled(),
    true,
  );
  assert.equal(store.setting<any>("preferences", {}).notifyProgress, false);
});

test("muting immediately suppresses pending and future retry notifications while preserving direct replies", async (t) => {
  const { notices, store, channel } = await setup(t);
  const pending = notices.enqueue("任务结束", "finished:pending")!;
  const retry = notices.enqueue("重试提醒", "reminder:retry")!;
  store.put<Delivery>("notification_deliveries", {
    ...store.get<Delivery>("notification_deliveries", retry)!,
    status: "retry",
    nextAttemptAt: Date.now() + 86400000,
    attempts: 1,
    error: "earlier network error",
  });
  const reply = notices.enqueue(
    "你的问题答案",
    "answer:one",
    "owner",
    "reply",
  )!;
  notices.setPushEnabled(false);
  for (const id of [pending, retry]) {
    const record = store.get<Delivery>("notification_deliveries", id)!;
    assert.equal(record.status, "suppressed");
    assert.ok(record.suppressedAt);
    assert.match(record.error!, /推送已关闭/);
  }
  assert.match(
    store.get<Delivery>("notification_deliveries", retry)!.error!,
    /earlier network error/,
  );
  assert.equal(
    store.get<Delivery>("notification_deliveries", reply)!.status,
    "pending",
  );
  await notices.flush();
  assert.deepEqual(
    channel.sent.map((message) => message.text),
    ["你的问题答案"],
  );
});

test("muted notification records remain auditable and deduplicated and are never replayed on enable", async (t) => {
  const { notices, store, channel } = await setup(t);
  notices.setPushEnabled(false);
  const keys = [
    "finished:task",
    "phase:task",
    "reminder:todo",
    "desktop-completion:thread",
  ];
  const ids = keys.map((key) => notices.enqueue(key, key)!);
  for (const id of ids) {
    const record = store.get<Delivery>("notification_deliveries", id)!;
    assert.equal(record.status, "suppressed");
    assert.equal(record.attempts, 0);
  }
  assert.equal(notices.enqueue("重复结果", keys[0]), ids[0]);
  notices.setPushEnabled(true);
  assert.equal(notices.enqueue("再次重复", keys[0]), ids[0]);
  await notices.flush(Date.now() + 86400000);
  assert.equal(channel.sent.length, 0);
  notices.enqueue("开启后的新通知", "finished:new");
  await notices.flush();
  assert.deepEqual(
    channel.sent.map((message) => message.text),
    ["开启后的新通知"],
  );
  assert.equal(
    store
      .all<Delivery>("notification_deliveries")
      .filter((delivery) => delivery.status === "suppressed").length,
    4,
  );
});

test("legacy answer and reply records still send during mute while other legacy messages are suppressed", async (t) => {
  const { notices, store, channel } = await setup(t);
  legacy(store, "answer:old");
  legacy(store, "reply:old");
  legacy(store, "finished:old");
  legacy(store, "unknown-old-key");
  notices.setPushEnabled(false);
  await notices.flush();
  assert.deepEqual(channel.sent.map((message) => message.text).sort(), [
    "answer:old",
    "reply:old",
  ]);
  for (const key of ["finished:old", "unknown-old-key"])
    assert.equal(
      store.get<Delivery>("notification_deliveries", key)!.status,
      "suppressed",
    );
});

test("completions discovered after re-enabling retain their occurrence time and do not replay muted results", async (t) => {
  const { notices, store, channel } = await setup(t);
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  notices.setPushEnabled(false);
  const completedWhileMuted = now + 1000;
  now += 2000;
  // The settings API saves preferences before calling the notification manager.
  store.setSetting("preferences", { wechatPushEnabled: true });
  notices.setPushEnabled(true);
  const resumedAt = now;
  assert.equal(store.setting("wechatPushResumedAt", 0), resumedAt);

  now += 15000;
  const restarted = new NotificationManager(store, channel);
  const old = restarted.enqueue(
    "静音期间完成，稍后才被扫描到",
    "desktop-completion:late-discovery",
    "owner",
    "notification",
    completedWhileMuted,
  )!;
  const oldRecord = store.get<Delivery>("notification_deliveries", old)!;
  assert.equal(oldRecord.occurredAt, completedWhileMuted);
  assert.equal(oldRecord.status, "suppressed");
  assert.equal(oldRecord.attempts, 0);
  assert.equal(oldRecord.suppressedAt, now);

  restarted.enqueue(
    "恢复时完成的新结果",
    "desktop-completion:at-boundary",
    "owner",
    "notification",
    resumedAt,
  );
  restarted.enqueue(
    "恢复之后完成的新结果",
    "desktop-completion:after-boundary",
    "owner",
    "notification",
    resumedAt + 1,
  );
  restarted.enqueue("未传发生时间的新通知", "finished:no-occurrence");
  restarted.enqueue(
    "关闭期间提问的直接回答",
    "answer:old-question",
    "owner",
    "reply",
    completedWhileMuted,
  );
  await restarted.flush();
  assert.deepEqual(channel.sent.map((message) => message.text).sort(), [
    "关闭期间提问的直接回答",
    "恢复之后完成的新结果",
    "恢复时完成的新结果",
    "未传发生时间的新通知",
  ].sort());
  assert.equal(
    store.get<Delivery>("notification_deliveries", old)!.status,
    "suppressed",
  );
});

test("explicit enable refreshes the persisted occurrence cutoff and suppresses older pending notifications", async (t) => {
  const { notices, store, channel } = await setup(t);
  let now = 200000;
  t.mock.method(Date, "now", () => now);
  notices.setPushEnabled(true);
  const pending = notices.enqueue(
    "上一轮扫描的完成结果",
    "desktop-completion:pending",
    "owner",
    "notification",
    now,
  )!;
  now += 1000;
  notices.setPushEnabled(true);
  assert.equal(store.setting("wechatPushResumedAt", 0), now);
  assert.equal(
    store.get<Delivery>("notification_deliveries", pending)!.status,
    "suppressed",
  );
  await notices.flush();
  assert.equal(channel.sent.length, 0);
});

test("config-default mute applies during recovery without changing uncertain sends", async (t) => {
  const { notices, store, channel } = await setup(t, false);
  assert.equal(notices.isPushEnabled(), false);
  legacy(store, "finished:pending");
  legacy(store, "reply:pending");
  legacy(store, "finished:in-flight", "sending");
  notices.recover();
  assert.equal(
    store.get<Delivery>("notification_deliveries", "finished:pending")!.status,
    "suppressed",
  );
  assert.equal(
    store.get<Delivery>("notification_deliveries", "finished:in-flight")!
      .status,
    "delivery_unverified",
  );
  notices.setPushEnabled(true);
  await notices.flush();
  assert.deepEqual(
    channel.sent.map((message) => message.text),
    ["reply:pending"],
  );
});

test("a mute between channel calls leaves the in-flight send intact and stops later queued sends even after re-enable", async (t) => {
  const { notices, store, channel } = await setup(t);
  const first = notices.enqueue("已经开始发送", "finished:first")!;
  const second = notices.enqueue("还没有发送", "finished:second")!;
  store.put<Delivery>("notification_deliveries", {
    ...store.get<Delivery>("notification_deliveries", first)!,
    createdAt: 1,
  });
  store.put<Delivery>("notification_deliveries", {
    ...store.get<Delivery>("notification_deliveries", second)!,
    createdAt: 2,
  });
  const entered = deferred(),
    release = deferred();
  const send = channel.sendMessage.bind(channel);
  channel.sendMessage = async (user, text, id) => {
    entered.resolve();
    await release.promise;
    return send(user, text, id);
  };
  const flushing = notices.flush();
  await entered.promise;
  notices.setPushEnabled(false);
  assert.equal(
    store.get<Delivery>("notification_deliveries", first)!.status,
    "sending",
  );
  assert.equal(
    store.get<Delivery>("notification_deliveries", second)!.status,
    "suppressed",
  );
  notices.setPushEnabled(true);
  release.resolve();
  await flushing;
  assert.deepEqual(
    channel.sent.map((message) => message.text),
    ["已经开始发送"],
  );
  assert.equal(
    store.get<Delivery>("notification_deliveries", first)!.status,
    "server_accepted",
  );
});

test("failed in-flight notifications do not become a backlog after mute and quick re-enable", async (t) => {
  const { notices, store, channel } = await setup(t);
  const id = notices.enqueue("旧通知", "finished:in-flight")!;
  const entered = deferred(),
    release = deferred();
  let attempts = 0;
  channel.sendMessage = async () => {
    attempts++;
    entered.resolve();
    await release.promise;
    throw new Error("definite network failure");
  };
  const flushing = notices.flush();
  await entered.promise;
  notices.setPushEnabled(false);
  notices.setPushEnabled(true);
  release.resolve();
  await flushing;
  assert.equal(
    store.get<Delivery>("notification_deliveries", id)!.status,
    "suppressed",
  );
  await notices.flush(Date.now() + 60000);
  assert.equal(attempts, 1);
});

test("uncertain in-flight delivery remains unverified when muted and is not retried", async (t) => {
  const { notices, store, channel } = await setup(t);
  const id = notices.enqueue("不确定结果", "finished:uncertain")!;
  const entered = deferred(),
    release = deferred();
  let attempts = 0;
  channel.sendMessage = async () => {
    attempts++;
    entered.resolve();
    await release.promise;
    throw new DeliveryUncertainError("server response timed out");
  };
  const flushing = notices.flush();
  await entered.promise;
  notices.setPushEnabled(false);
  release.resolve();
  await flushing;
  assert.equal(
    store.get<Delivery>("notification_deliveries", id)!.status,
    "delivery_unverified",
  );
  notices.setPushEnabled(true);
  await notices.flush(Date.now() + 60000);
  assert.equal(attempts, 1);
});

test("muted one-shot reminders are consumed and recurring reminders advance without queued catch-up", async (t) => {
  const { notices, store, channel } = await setup(t);
  const todos = new TodoManager(store, notices, loadConfig("nonexistent.json"));
  const now = Date.now();
  store.put<Todo>("todos", {
    id: "todo",
    title: "交报告",
    status: "open",
    sourceId: "source",
    sourceText: "交报告",
    parsedAt: now,
    dedupeKey: "todo",
  });
  store.put<Reminder>("reminders", {
    id: "once",
    todoId: "todo",
    dueAt: now - 1,
    status: "scheduled",
  });
  store.put<Reminder>("reminders", {
    id: "repeat",
    todoId: "todo",
    dueAt: now - 600000,
    repeatMinutes: 1,
    status: "scheduled",
  });
  notices.setPushEnabled(false);
  todos.tick(now);
  assert.equal(store.get<Reminder>("reminders", "once")!.status, "queued");
  assert.ok(store.get<Reminder>("reminders", "once")!.deliveryId);
  const next = store.get<Reminder>("reminders", "repeat")!.dueAt;
  assert.ok(next > now);
  assert.equal(store.all<Delivery>("notification_deliveries").length, 2);
  assert.ok(
    store
      .all<Delivery>("notification_deliveries")
      .every((delivery) => delivery.status === "suppressed"),
  );
  todos.tick(now);
  notices.setPushEnabled(true);
  todos.tick(now);
  await notices.flush();
  assert.equal(channel.sent.length, 0);
  assert.equal(store.all<Delivery>("notification_deliveries").length, 2);
  todos.tick(next);
  await notices.flush(next);
  assert.equal(channel.sent.length, 1);
  assert.ok(store.get<Reminder>("reminders", "repeat")!.dueAt > next);
});

test("muting task notifications does not stop execution or progression to the next stage", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  f.notices.setPushEnabled(false);
  const task = f.tasks.create(f.project.id, "两阶段任务", [
    {
      title: "第一步",
      prompt: "检查",
      requiresApproval: false,
      lowRisk: false,
    },
    {
      title: "第二步",
      prompt: "汇总",
      requiresApproval: false,
      lowRisk: false,
    },
  ]);
  for (let index = 0; index < 2; index++) {
    await f.tasks.pump();
    const current = f.store.get<Task>("tasks", task.id)!;
    assert.equal(current.status, "RUNNING");
    f.codex.emit("turn/completed", {
      threadId: current.threadId,
      turn: { id: current.turnId, status: "completed" },
    });
    await f.tasks.drained();
  }
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "COMPLETED");
  assert.equal(
    f.codex.calls.filter((call) => call.method === "turn/start").length,
    2,
  );
  assert.ok(
    f.store
      .all<Delivery>("notification_deliveries")
      .every((delivery) => delivery.status === "suppressed"),
  );
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 0);
});
