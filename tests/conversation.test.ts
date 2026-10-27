import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { Question } from "../src/codex/questions.js";
import type { Approval, Delivery, Task } from "../src/app/types.js";
import { answerAccount } from "../src/codex/account.js";

test("all ordinary messages go to Codex before any business classification", async () => {
  const f = await fixture();
  for (const text of [
    "我还有多少token",
    "明天会下雨吗",
    "状态机是什么",
    "帮我分析这句话",
    "继续解释",
    "明天下午三点提醒我交报告",
    "帮我检查项目代码",
  ]) {
    await f.router.receive({
      id: text,
      text,
      userId: "owner",
      sentAt: Date.now(),
      kind: "direct",
    });
    assert.equal(f.store.get<Question>("questions", text)?.text, text);
  }
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.todos.list().length, 0);
  assert.equal(f.store.all("notification_deliveries").length, 0);
});
test("model answer and follow-up reuse analysis thread, with actual results in context", async () => {
  const f = await fixture();
  f.questions.enqueue("状态机是什么", "owner", "one");
  const q = await f.decide("one", { reply: "状态机用状态和事件描述变化。" });
  assert.equal(q.answer, "状态机用状态和事件描述变化。");
  f.questions.enqueue("举个例子", "owner", "two");
  const q2 = await f.decide("two", { reply: "红绿灯就是一个例子。" });
  assert.equal(q.threadId, q2.threadId);
  assert.ok(f.codex.calls.some((c) => c.method === "thread/resume"));
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.todos.list().length, 0);
  const input = JSON.parse(
    f.codex.calls.filter((c) => c.method === "turn/start").at(-1)!.params
      .input[0].text,
  );
  assert.equal(input.userMessage, "举个例子");
  assert.equal(input.bridgeContext.recentResults[0].result, q.answer);
});
test("structured decision cannot select an unauthorized project or replay task creation", async () => {
  const f = await fixture();
  f.questions.enqueue("帮我改代码", "owner", "bad");
  const bad = await f.decide("bad", {
    action: "run",
    projectId: "invented",
    text: "修改代码",
  });
  assert.equal(bad.status, "failed");
  assert.equal(f.tasks.tasks().length, 0);
  f.questions.enqueue("帮我改代码", "owner", "good");
  const q = await f.decide("good", {
    action: "run",
    projectId: f.project.id,
    text: "修改代码，保留原始文件",
  });
  f.codex.emit("turn/completed", {
    threadId: q.threadId,
    turn: { id: q.turnId, status: "completed" },
  });
  await f.questions.drained();
  assert.equal(f.tasks.tasks().length, 1);
  assert.ok(f.tasks.tasks()[0]!.title.includes("保留原始文件"));
});
test("model reminder clarification does not fabricate a date or create a premature todo", async () => {
  const f = await fixture();
  f.questions.enqueue("明天下午提醒我交报告", "owner", "one");
  await f.decide("one", {
    action: "add_todo",
    text: "交报告",
    reply: "明天下午具体几点提醒？",
  });
  assert.equal(f.todos.list().length, 0);
  f.questions.enqueue("三点", "owner", "two");
  await f.decide("two", {
    action: "add_todo",
    text: "交报告",
    date: "2099-10-26 15:00",
  });
  assert.equal(f.todos.list().length, 1);
  assert.equal(f.todos.list()[0]!.status, "open");
});
test("invalid model JSON is repaired silently twice before failing without actions", async () => {
  const f = await fixture();
  f.questions.enqueue("问个问题", "owner", "one");
  await f.questions.pump();
  for (let attempt = 0; attempt < 3; attempt++) {
    const q = f.store.get<Question>("questions", "one")!;
    f.codex.emit("item/completed", {
      threadId: q.threadId,
      turnId: q.turnId,
      item: { type: "agentMessage", text: "not a decision" },
    });
    f.codex.emit("turn/completed", {
      threadId: q.threadId,
      turn: { id: q.turnId, status: "completed" },
    });
    await f.questions.drained();
    const current = f.store.get<Question>("questions", "one")!;
    assert.equal(f.todos.list().length, 0);
    assert.equal(f.tasks.tasks().length, 0);
    if (attempt < 2) {
      assert.equal(current.status, "running");
      assert.equal(current.repairAttempts, attempt + 1);
      assert.notEqual(current.turnId, q.turnId);
      assert.equal(f.store.all("notification_deliveries").length, 0);
      const input = JSON.parse(
        f.codex.calls.filter((c) => c.method === "turn/start").at(-1)!.params
          .input[0].text,
      );
      assert.equal(input.computerObservation.kind, "decision_format_repair");
      assert.equal(input.userMessage, "问个问题");
    }
  }
  assert.equal(f.store.get<Question>("questions", "one")?.status, "failed");
  assert.equal(f.store.get<Question>("questions", "one")?.repairAttempts, 2);
  assert.equal(f.store.all<Delivery>("notification_deliveries").length, 1);
  assert.doesNotMatch(
    f.store.all<Delivery>("notification_deliveries")[0]!.text,
    /JSON|schema|not a decision/,
  );
});
test("analysis thread requests cannot approve tools and have only one owner", async () => {
  const f = await fixture();
  f.questions.enqueue("问问题", "owner", "one");
  await f.questions.pump();
  const q = f.store.get<Question>("questions", "one")!;
  f.codex.emit(
    "item/commandExecution/requestApproval",
    { threadId: q.threadId, turnId: q.turnId, command: "write" },
    12,
  );
  await f.questions.drained();
  await f.tasks.drained();
  assert.deepEqual(
    f.codex.responses.filter((x) => x.id === 12),
    [{ id: 12, result: { decision: "decline" } }],
  );
});
test("bare agreement interpreted by the model still cannot approve a pending operation", async () => {
  const f = await fixture();
  const task = f.tasks.create(f.project.id, "检查", [
    { title: "一", prompt: "一", requiresApproval: false, lowRisk: false },
    { title: "二", prompt: "二", requiresApproval: true, lowRisk: false },
  ]);
  await f.tasks.pump();
  const t = f.store.get<Task>("tasks", task.id)!;
  f.codex.emit("turn/completed", {
    threadId: t.threadId,
    turn: { id: t.turnId, status: "completed" },
  });
  await f.tasks.drained();
  const a = f.store.all<Approval>("approvals")[0]!;
  f.questions.enqueue("好的", "owner", "one");
  const q = await f.decide("one", { action: "approve", approvalId: a.id });
  assert.ok(q.answer?.includes("软件后台"));
  assert.equal(f.store.get<Approval>("approvals", a.id)?.status, "pending");
  f.questions.enqueue(`确认继续 ${a.id}`, "owner", "two");
  await f.decide("two", { action: "approve", approvalId: a.id });
  assert.equal(f.store.get<Approval>("approvals", a.id)?.status, "approved");
});
test("account intent queries real adapter data, never invents exact remaining tokens", async () => {
  const f = await fixture();
  const original = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) =>
    method === "account/rateLimits/read"
      ? ({
          rateLimits: {
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: 1900000000,
            },
          },
          ordinaryUsageAllowed: false,
        } as any)
      : original(method, params);
  f.questions.enqueue("我还有多少token", "owner", "one");
  const q = await f.decide("one", { action: "account" });
  assert.ok(q.answer?.includes("75%"));
  assert.ok(q.answer?.includes("5 小时"));
  assert.ok(q.answer?.includes("不提供"));
  assert.ok(q.answer?.includes("暂不可用"));
  assert.equal(f.todos.list().length, 0);
});
test("missing account statistics are not shown as zero or unlimited", async () => {
  const f = await fixture();
  const reply = await answerAccount(
    f.codex,
    "我还有多少token",
    f.config.timezone,
  );
  assert.ok(reply.includes("没有返回"));
  assert.equal(reply.includes("0%"), false);
});
test("restart never repeats an already claimed decision", async () => {
  const f = await fixture();
  f.store.put<Question>("questions", {
    id: "one",
    userId: "owner",
    text: "操作",
    createdAt: Date.now(),
    status: "dispatching",
  });
  f.questions.recover();
  await f.questions.pump();
  assert.equal(f.store.get<Question>("questions", "one")?.status, "failed");
  assert.equal(f.codex.calls.length, 0);
});
test("timeout sends an honest failure; late completion cannot execute a decision", async () => {
  const f = await fixture();
  f.questions.enqueue("问问题", "owner", "one");
  await f.questions.pump();
  const q = f.store.get<Question>("questions", "one")!;
  f.questions.monitor(Date.now() + 91000);
  await f.questions.drained();
  assert.equal(f.store.get<Question>("questions", "one")?.status, "failed");
  assert.ok(
    f.store
      .all<Delivery>("notification_deliveries")
      .some((d) => d.text.includes("超时")),
  );
  assert.equal(f.tasks.tasks().length, 0);
});
