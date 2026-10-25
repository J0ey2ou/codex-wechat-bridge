import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.js";
import type { Approval, Delivery, Task } from "../src/app/types.js";
import { ConversationManager } from "../src/app/conversation.js";
import { parseDate } from "../src/scheduler/dates.js";
test("help uses everyday examples instead of command reference", async () => {
  const f = await fixture();
  await f.router.receive({
    id: "help",
    userId: "owner",
    text: "/help",
    sentAt: Date.now(),
    kind: "direct",
  });
  const d = f.store
    .all<Delivery>("notification_deliveries")
    .find((d) => d.dedupeKey === "reply:help")!;
  assert.ok(d.text.includes("不用记指令"));
  assert.equal(d.text.includes("/run"), false);
});
test("greetings and thanks never become todos or Codex tasks", async () => {
  const f = await fixture();
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  for (const t of ["你好", "在吗？", "谢谢", "好的"])
    await c.reply(t, "owner", randomUUID());
  assert.equal(f.todos.list().length, 0);
  assert.equal(f.tasks.tasks().length, 0);
});
test("Chinese clock words and relative delays parse in timezone", () => {
  const now = DateTime.fromISO("2026-10-25T10:00:00", {
    zone: "Asia/Shanghai",
  }).toMillis();
  const d = parseDate("明天下午三点半提醒我交报告", "Asia/Shanghai", now);
  assert.equal(
    DateTime.fromMillis(d.at!, { zone: "Asia/Shanghai" }).toISO(),
    "2026-10-26T15:30:00.000+08:00",
  );
  assert.equal(
    parseDate("十分钟后提醒我", "Asia/Shanghai", now).at,
    now + 600000,
  );
  assert.equal(
    parseDate("半小时后提醒我", "Asia/Shanghai", now).at,
    now + 1800000,
  );
});
test("reminder clarification remembers tomorrow and accepts afternoon three", async () => {
  const f = await fixture();
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  const first = await c.reply("明天下午提醒我交报告", "owner", "one");
  assert.ok(first.includes("具体几点"));
  assert.equal(f.todos.list()[0]?.status, "draft");
  const next = await c.reply("下午三点", "owner", "two");
  assert.ok(next.includes("已记好"));
  const t = f.todos.list()[0]!;
  assert.equal(t.status, "open");
  assert.equal(
    DateTime.fromMillis(t.dueAt!, { zone: "Asia/Shanghai" }).hour,
    15,
  );
});
test("ambiguous statement asks execution vs todo, preserving original text", async () => {
  const f = await fixture();
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  const first = await c.reply("完善论文格式", "owner", "one");
  assert.ok(first.includes("待办"));
  assert.equal(f.tasks.tasks().length, 0);
  await c.reply("记下来", "owner", "two");
  assert.equal(f.todos.list()[0]?.title, "完善论文格式");
});
test("project clarification persists and reuses the original request", async () => {
  const f = await fixture();
  f.tasks.addProject("另一个", process.cwd() + "\\src");
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  const first = await c.reply("帮我检查代码有没有问题", "owner", "one");
  assert.ok(first.includes("哪个项目"));
  await c.reply("另一个", "owner", "two");
  assert.equal(f.tasks.tasks()[0]?.title, "帮我检查代码有没有问题");
  assert.equal(f.tasks.project(f.tasks.tasks()[0]!.projectId).name, "另一个");
});
test("natural completion selects prior ordered todo list without IDs", async () => {
  const f = await fixture();
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  f.todos.add("明天 12:00 提交报告", "one");
  f.todos.add("后天 12:00 检查结果", "two");
  const list = await c.reply("我还有哪些事没做？", "owner", "three");
  assert.ok(list.includes("2 件"));
  const reply = await c.reply("第二件做完了", "owner", "four");
  assert.ok(reply.includes("已完成"));
  assert.equal(f.todos.list().filter((t) => t.status === "done").length, 1);
});
test("bare agreement cannot approve an operation; explicit scoped natural confirmation works", async () => {
  const f = await fixture();
  const t = f.tasks.create(
    f.project.id,
    "检查",
    [1, 2].map((i) => ({
      title: `阶段${i}`,
      prompt: `阶段${i}`,
      requiresApproval: true,
      lowRisk: false,
    })),
  );
  await f.tasks.pump();
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit("turn/completed", {
    threadId: r.threadId,
    turn: { id: r.turnId, status: "completed" },
  });
  await f.tasks.drained();
  const a = f.store.all<Approval>("approvals")[0]!;
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  const ask = await c.reply("好的", "owner", "one");
  assert.ok(ask.includes("确认继续"));
  assert.equal(f.store.get<Approval>("approvals", a.id)?.status, "pending");
  await c.reply(`确认继续 ${a.id}`, "owner", "two");
  assert.equal(f.store.get<Approval>("approvals", a.id)?.status, "approved");
  await assert.rejects(c.reply(`确认继续 ${a.id}`, "owner", "three"));
});
test("a new constraint while waiting for a stage is preserved", async () => {
  const f = await fixture();
  const t = f.tasks.create(
    f.project.id,
    "检查",
    [1, 2].map((i) => ({
      title: `阶段${i}`,
      prompt: `阶段${i}`,
      requiresApproval: true,
      lowRisk: false,
    })),
  );
  await f.tasks.pump();
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit("turn/completed", {
    threadId: r.threadId,
    turn: { id: r.turnId, status: "completed" },
  });
  await f.tasks.drained();
  const c = new ConversationManager(f.store, f.tasks, f.todos, f.config);
  await c.reply("继续当前任务，但不要删除原始文件", "owner", "one");
  assert.ok(
    f.store
      .get<Task>("tasks", t.id)
      ?.stages[1]?.prompt.includes("不要删除原始文件"),
  );
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "QUEUED");
});
