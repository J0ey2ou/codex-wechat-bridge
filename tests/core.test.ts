import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { fixture } from "./helpers.js";
import type { Approval, Delivery, Task, Reminder } from "../src/app/types.js";
import { Store, tables } from "../src/storage/store.js";
import { assertTransition } from "../src/tasks/state.js";
import { parseDate, extractCandidates } from "../src/scheduler/dates.js";
import { within, safeText } from "../src/security/policy.js";
const time = DateTime.fromISO("2026-10-25T10:00:00", {
  zone: "Asia/Shanghai",
}).toMillis();
test("SQLite migrations and persistent data survive restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-test-"));
  const file = path.join(dir, "db.sqlite");
  let db = new Store(file);
  db.put("projects", { id: "p", name: "持久化" });
  assert.equal(
    db.db.prepare("SELECT COUNT(*) n FROM schema_migrations").get()?.n,
    1,
  );
  db.close();
  db = new Store(file);
  assert.equal(db.get<any>("projects", "p").name, "持久化");
  for (const t of tables) assert.ok(db.all(t));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test("state machine rejects reviving completed tasks", () => {
  assert.throws(() => assertTransition("COMPLETED", "RUNNING"));
  assert.doesNotThrow(() => assertTransition("UNKNOWN", "RUNNING"));
});
test("path containment distinguishes sibling prefix", () => {
  assert.equal(within(path.resolve("a"), path.resolve("a2")), false);
  assert.equal(within(path.resolve("a"), path.resolve("a/b")), true);
});
test("sensitive text is redacted", () => {
  assert.equal(
    safeText("Bearer abcdef password=secret bot_token=token").includes(
      "secret",
    ),
    false,
  );
});
test("absolute and relative dates use configured timezone", () => {
  const d = parseDate("明天 15:30 完成报告", "Asia/Shanghai", time);
  assert.equal(
    DateTime.fromMillis(d.at!, { zone: "Asia/Shanghai" }).toISO(),
    "2026-10-26T15:30:00.000+08:00",
  );
  assert.ok(parseDate("2026-10-28 09:00", "America/New_York", time).at);
});
test("next week context applies to both explicit weekday clauses", () => {
  const d = extractCandidates(
    "下周三之前完成论文修改，周二先检查一遍统计结果",
    "Asia/Shanghai",
    time,
  );
  assert.equal(
    DateTime.fromMillis(d[0]!.at!, { zone: "Asia/Shanghai" }).toISODate(),
    "2026-10-28",
  );
  assert.equal(
    DateTime.fromMillis(d[1]!.at!, { zone: "Asia/Shanghai" }).toISODate(),
    "2026-10-27",
  );
});
test("ambiguous, missing, invalid and past dates are not invented", () => {
  for (const text of [
    "明天下午完成报告",
    "今天晚上提醒我检查进度",
    "完成论文",
    "2026-02-30",
    "2025-01-01",
    "明天25:00",
  ])
    assert.ok(parseDate(text, "Asia/Shanghai", time).ambiguity);
});
test("unauthorized sender cannot create task or todo", async () => {
  const f = await fixture();
  await f.router.receive({
    id: "1",
    userId: "attacker",
    text: "/run 项目 | 删除文件",
    sentAt: Date.now(),
    kind: "direct",
  });
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.store.all("messages").length, 0);
});
test("message dedupe, acknowledgement, command route, and replay protection", async () => {
  const f = await fixture();
  const m = {
    id: "1",
    userId: "owner",
    text: "/run 项目 | 检查代码",
    sentAt: Date.now(),
    kind: "direct" as const,
  };
  await Promise.all([f.router.receive(m), f.router.receive(m)]);
  assert.equal(f.tasks.tasks().length, 1);
  await f.router.receive({ ...m, id: "2", sentAt: Date.now() - 3600000 });
  assert.equal(f.tasks.tasks().length, 1);
  await f.notices.flush();
  assert.ok(f.channel.sent.some((s) => s.text.includes("已收到")));
});
test("forwarded command is data, never executable", async () => {
  const f = await fixture();
  await f.router.receive({
    id: "fwd",
    userId: "owner",
    text: "/run 项目 | 删除文件",
    sentAt: Date.now(),
    kind: "forwarded",
  });
  f.todos.collect(Date.now() + 1);
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.todos.list().length, 1);
});
test("natural language task launch requires recognized explicit intent", async () => {
  const f = await fixture();
  await f.router.receive({
    id: "natural",
    userId: "owner",
    text: "打开 项目 项目，检查代码",
    sentAt: Date.now(),
    kind: "direct",
  });
  assert.equal(f.tasks.tasks().length, 1);
});
test("natural status includes all required fields without imaginary ETA", async () => {
  const f = await fixture();
  f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  await f.router.receive({
    id: "status",
    userId: "owner",
    text: "Codex 现在在做什么？",
    sentAt: Date.now(),
    kind: "direct",
  });
  const d = f.store
    .all<Delivery>("notification_deliveries")
    .find((d) => d.dedupeKey === "reply:status")!;
  for (const s of [
    "项目",
    "任务",
    "状态",
    "开始",
    "运行",
    "最近活动",
    "阶段",
    "最近事件",
    "需要操作",
    "预计剩余：无可靠依据",
  ])
    assert.ok(d.text.includes(s), s);
});
test("multi-stage completion waits for scoped approval then resumes same session", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "两阶段", [
    { title: "检查", prompt: "检查", requiresApproval: false, lowRisk: true },
    { title: "运行", prompt: "运行", requiresApproval: true, lowRisk: false },
  ]);
  await f.tasks.pump();
  const running = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit("turn/completed", {
    threadId: running.threadId,
    turn: { id: running.turnId, status: "completed" },
  });
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "WAITING_APPROVAL");
  const a = f.store.all<Approval>("approvals")[0]!;
  await assert.rejects(f.tasks.decide("wrong-id", "approve"));
  await f.tasks.decide(a.id, "approve");
  await assert.rejects(f.tasks.decide(a.id, "approve"));
  await f.tasks.pump();
  assert.equal(
    f.codex.calls.filter((c) => c.method === "thread/start").length,
    1,
  );
  assert.equal(
    f.codex.calls.filter((c) => c.method === "thread/resume").length,
    1,
  );
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    2,
  );
});
test("queued tasks do not concurrently write to same project thread", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "第一");
  f.tasks.create(f.project.id, "第二");
  await Promise.all([f.tasks.pump(), f.tasks.pump()]);
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit("turn/completed", {
    threadId: r.threadId,
    turn: { id: r.turnId, status: "completed" },
  });
  await f.tasks.drained();
  await f.tasks.pump();
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    2,
  );
  assert.equal(
    f.codex.calls.filter((c) => c.method === "thread/start").length,
    1,
  );
});
test("stop waits for actual turn interruption event", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  await f.tasks.stop(t.id);
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "INTERRUPTED");
  assert.ok(f.codex.calls.some((c) => c.method === "turn/interrupt"));
});
test("wrong turn event cannot complete active task", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  f.codex.emit("turn/completed", {
    threadId: f.store.get<Task>("tasks", t.id)!.threadId,
    turn: { id: "wrong", status: "completed" },
  });
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "RUNNING");
});
test("external command item gives WAITING_PROCESS with process identifier", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit("item/started", {
    threadId: r.threadId,
    turnId: r.turnId,
    item: { id: "cmd", type: "commandExecution", processId: "42" },
  });
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "WAITING_PROCESS");
  assert.deepEqual(f.store.get<Task>("tasks", t.id)?.processIds, ["42"]);
});
test("command approvals require local review; reconnect invalidates old request", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit(
    "item/commandExecution/requestApproval",
    {
      threadId: r.threadId,
      turnId: r.turnId,
      itemId: "c",
      command: "python model.py",
      cwd: f.project.path,
    },
    23,
  );
  await f.tasks.drained();
  const a = f.store.all<Approval>("approvals")[0]!;
  await assert.rejects(f.tasks.decide(a.id, "approve"));
  await f.codex.reconnect();
  await f.tasks.drained();
  await assert.rejects(f.tasks.decide(a.id, "approve", true));
  assert.equal(f.codex.responses.length, 0);
});
test("file approval cannot permit files outside project", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit("item/started", {
    threadId: r.threadId,
    turnId: r.turnId,
    item: {
      id: "patch",
      type: "fileChange",
      changes: [
        { path: path.resolve("..", "outside.txt"), kind: { type: "delete" } },
      ],
    },
  });
  f.codex.emit(
    "item/fileChange/requestApproval",
    { threadId: r.threadId, turnId: r.turnId, itemId: "patch" },
    9,
  );
  await f.tasks.drained();
  const a = f.store.all<Approval>("approvals")[0]!;
  assert.equal(a.allowed, false);
  await assert.rejects(f.tasks.decide(a.id, "approve", true));
  await f.tasks.decide(a.id, "reject");
  assert.deepEqual(f.codex.responses[0]?.result, { decision: "decline" });
});
test("unknown permissions interactions fail closed", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  const r = f.store.get<Task>("tasks", t.id)!;
  f.codex.emit(
    "item/permissions/requestApproval",
    { threadId: r.threadId, turnId: r.turnId },
    12,
  );
  await f.tasks.drained();
  assert.deepEqual(f.codex.responses[0]?.result, {
    permissions: {},
    scope: "turn",
  });
});
test("restart never blindly resumes RUNNING and blocks project queue", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "第一");
  f.tasks.create(f.project.id, "第二");
  await f.tasks.pump();
  f.tasks.recover();
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "UNKNOWN");
  await f.tasks.pump();
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
});
test("silence becomes UNKNOWN, not false computation progress", async () => {
  const f = await fixture();
  const t = f.tasks.create(f.project.id, "检查");
  await f.tasks.pump();
  await f.tasks.monitor(Date.now() + 11 * 60000);
  assert.equal(f.store.get<Task>("tasks", t.id)?.status, "UNKNOWN");
});
test("todo extraction deduplication, confirmation and lifecycle", async () => {
  const f = await fixture();
  const ts = f.todos.add(
    "明天下午完成报告，今天晚上提醒我检查进度",
    "one",
    time,
  );
  assert.equal(ts.length, 2);
  assert.equal(ts[0]?.status, "draft");
  f.todos.add("明天下午完成报告，今天晚上提醒我检查进度", "two", time);
  assert.equal(f.todos.list().length, 2);
  f.todos.confirm(ts[0]!.id, "无日期");
  assert.equal(f.todos.list().find((x) => x.id === ts[0]!.id)?.status, "open");
  f.todos.change(ts[0]!.id, "done");
  assert.equal(f.todos.list().find((x) => x.id === ts[0]!.id)?.status, "done");
});
test("durable scheduler fires reminder once, cancels pending delivery on completion", async () => {
  const f = await fixture();
  const ts = f.todos.add("明天 10:00 提交报告", "one");
  const r = f.store.all<Reminder>("reminders")[0]!;
  f.todos.tick(r.dueAt + 1);
  f.todos.tick(r.dueAt + 2);
  assert.equal(f.store.all<Delivery>("notification_deliveries").length, 1);
  f.todos.change(ts[0]!.id, "done");
  assert.equal(
    f.store.all<Delivery>("notification_deliveries")[0]?.status,
    "cancelled",
  );
});
test("repeating reminder skips missed intervals without flooding", async () => {
  const f = await fixture();
  const ts = f.todos.add("无日期工作", "one");
  f.todos.confirm(ts[0]!.id, "无日期");
  const r = f.todos.remind(ts[0]!.id, "明天 10:00", 15);
  f.todos.tick(r.dueAt + 60 * 60000);
  assert.equal(f.store.all<Delivery>("notification_deliveries").length, 1);
  assert.ok(
    f.store.get<Reminder>("reminders", r.id)!.dueAt > r.dueAt + 60 * 60000,
  );
});
test("outbox persists failed delivery and retries with stable client ID", async () => {
  const f = await fixture();
  f.notices.enqueue("测试", "delivery");
  f.channel.fail = true;
  await f.notices.flush();
  let d = f.store.all<Delivery>("notification_deliveries")[0]!;
  assert.equal(d.status, "retry");
  assert.ok(d.error);
  f.channel.fail = false;
  await f.notices.flush(d.nextAttemptAt + 1);
  d = f.store.all<Delivery>("notification_deliveries")[0]!;
  assert.equal(d.status, "server_accepted");
  assert.equal(d.clientVisible, false);
  assert.equal(f.channel.sent[0]?.clientId, d.id);
});
test("outbox recovery does not replay uncertain sends", async () => {
  const f = await fixture();
  f.notices.enqueue("测试", "delivery");
  const d = f.store.all<Delivery>("notification_deliveries")[0]!;
  d.status = "sending";
  f.store.put("notification_deliveries", d);
  f.notices.recover();
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 0);
  assert.equal(
    f.store.get<Delivery>("notification_deliveries", d.id)?.status,
    "delivery_unverified",
  );
});
test('duplicate turn completion cannot skip a pending stage',async()=>{const f=await fixture();const t=f.tasks.create(f.project.id,'三阶段',[1,2,3].map(i=>({title:`阶段${i}`,prompt:`阶段${i}`,requiresApproval:i>1,lowRisk:false})));await f.tasks.pump();const r=f.store.get<Task>('tasks',t.id)!;const event={threadId:r.threadId,turn:{id:r.turnId,status:'completed'}};f.codex.emit('turn/completed',event);await f.tasks.drained();f.codex.emit('turn/completed',event);await f.tasks.drained();assert.equal(f.store.get<Task>('tasks',t.id)?.stageIndex,1);assert.equal(f.store.all<Approval>('approvals').filter(a=>a.status==='pending').length,1);});
test('restart during approval resolution fails closed instead of leaving a stranded approval',async()=>{const f=await fixture();const t=f.tasks.create(f.project.id,'两阶段',[1,2].map(i=>({title:`阶段${i}`,prompt:`阶段${i}`,requiresApproval:true,lowRisk:false})));await f.tasks.pump();const r=f.store.get<Task>('tasks',t.id)!;f.codex.emit('turn/completed',{threadId:r.threadId,turn:{id:r.turnId,status:'completed'}});await f.tasks.drained();const a=f.store.all<Approval>('approvals')[0]!;a.status='resolving';f.store.put('approvals',a);f.tasks.recover();assert.equal(f.store.get<Task>('tasks',t.id)?.status,'UNKNOWN');assert.equal(f.store.get<Approval>('approvals',a.id)?.status,'expired');});
test('completing recurring todo cancels every pending reminder delivery',async()=>{const f=await fixture();const [t]=f.todos.add('检查进度','one');f.todos.confirm(t!.id,'无日期');const r=f.todos.remind(t!.id,'明天 10:00',1);f.todos.tick(r.dueAt+1);f.todos.tick(r.dueAt+60001);assert.equal(f.store.all<Delivery>('notification_deliveries').length,2);f.todos.change(t!.id,'done');assert.ok(f.store.all<Delivery>('notification_deliveries').every(d=>d.status==='cancelled'));});
