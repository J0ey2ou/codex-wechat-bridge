import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { Delivery, StoredMessage } from "../src/app/types.js";
import { replyLayout, effectiveVoice } from "../src/app/dialogue.js";
import { conciseReply } from "../src/notifications/task-message.js";
import { MemoryManager } from "../src/app/memory.js";

const incoming = (id: string, text: string) => ({
  id,
  text,
  userId: "owner",
  sentAt: Date.now(),
  kind: "direct" as const,
});

test("the same current-user voice reaches QA and execution, and disabling memory removes learned style", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  new MemoryManager(f.store).update("owner", {
    tone: "direct",
    detail: "brief",
  });
  assert.equal(f.dispatcher.context("owner").effectiveVoice.tone, "direct");
  const task = f.tasks.create(f.project.id, "检查当前任务");
  await f.tasks.pump();
  const params = f.codex.calls.find((c) =>
    ["thread/start", "thread/resume"].includes(c.method),
  )!.params;
  assert.match(params.developerInstructions, /直接给重点/);
  assert.match(params.developerInstructions, /优先一两句/);
  assert.equal(
    effectiveVoice({ enabled: false, tone: "warm", detail: "detailed" }).tone,
    "natural",
  );
  assert.equal(effectiveVoice({ enabled: true }).extraModelCalls, 0);
  assert.ok(task.id);
});

for (const [label, request, answer, expected] of [
  [
    "chat",
    "穆戈，今天只想随便聊聊",
    "好的。\n\n- 那就随便聊聊，不用赶着找话题。",
    "那就随便聊聊，不用赶着找话题。",
  ],
  [
    "complaint",
    "这回复太像公文了，不要分点",
    "## 回应\n确实有点端着了。\n\n- 咱们就顺着聊，不用每句话都做总结。",
    "确实有点端着了。 咱们就顺着聊，不用每句话都做总结。",
  ],
  [
    "clarification",
    "帮我新建项目",
    "明白。\n\n1. 这个项目叫什么名字？",
    "这个项目叫什么名字？",
  ],
  [
    "facts",
    "创建结果呢",
    "## 完成情况\n- 已创建“读书笔记”，项目 ID：official-real-id。\n- 请求模型是 gpt-6.1-sol，实际模型还没核实。\n- 初始任务定在 2026-10-27 16:30。",
    "已创建“读书笔记”，项目 ID：official-real-id。 请求模型是 gpt-6.1-sol，实际模型还没核实。 初始任务定在 2026-10-27 16:30。",
  ],
  [
    "answer-not-receipt",
    "接着说",
    "收到，已交给你的结果里，哪些地方还没确认？",
    "收到，已交给你的结果里，哪些地方还没确认？",
  ],
] as const) {
  test(`outgoing ${label} is connected prose with no extra model turn`, async () => {
    const f = await fixture();
    await f.router.receive(incoming(label, request));
    const q = await f.decide(label, { reply: answer });
    await f.notices.flush(Date.now() + 1000);
    assert.deepEqual(
      f.channel.sent.map((d) => d.text),
      [expected],
    );
    assert.equal(q.answer, answer, "raw result remains in backend");
    assert.equal(q.replyText, expected);
    assert.equal(
      f.dispatcher.context("owner").recentResults[0]!.result,
      expected,
    );
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      1,
    );
    assert.equal(f.tasks.tasks().length, 0);
  });
}

test("engineering handoff uses one receipt, keeps full task, and sends a paragraph result", async () => {
  const f = await fixture();
  const request = "帮我优化项目里的通知功能，完整要求只留后台。";
  await f.router.receive(incoming("engineering", request));
  await f.decide("engineering", {
    action: "run",
    projectId: f.project.id,
    text: request,
  });
  await f.notices.flush(Date.now() + 1000);
  assert.deepEqual(
    f.channel.sent.map((d) => d.text),
    ["收到了，我处理一下。"],
  );
  const task = f.tasks.tasks()[0]!;
  assert.ok(task.stages.some((s) => s.prompt.includes(request)));
  await f.tasks.pump();
  await f.notices.flush();
  assert.equal(
    f.channel.sent.length,
    1,
    "no start template overwrites the receipt",
  );
  const active = f.tasks.tasks()[0]!;
  f.codex.emit("item/completed", {
    threadId: active.threadId,
    turnId: active.turnId,
    item: {
      type: "agentMessage",
      text: JSON.stringify({
        summary: "技术证据仅后台保存。服务尚未重启。",
        userMessage:
          "## 完成情况\n1. 通知已经简化。\n\n## 后续建议\n2. 服务尚未重启，当前微信仍使用旧版本。",
        files: ["private.ts"],
        tests: ["node check exitCode=0"],
        next: "",
      }),
    },
  });
  f.codex.emit("turn/completed", {
    threadId: active.threadId,
    turn: { id: active.turnId, status: "completed" },
  });
  await f.tasks.drained();
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 2);
  assert.equal(
    f.channel.sent[1]!.text,
    "“项目”： 通知已经简化。 服务尚未重启，当前微信仍使用旧版本。",
  );
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    2,
    "one decision and one execution; no polish call",
  );
});

for (const [request, answer] of [
  ["把选择分点说", "1. 安全更新\n2. 模型选择"],
  ["列出项目", "- 项目甲：official-a\n- 项目乙：official-b"],
  [
    "给我几个优化方向，说明现状、收益、工作量和优先级",
    "1. 安全更新：任务完成后切换版本，优先做。\n2. 模型选择：显示实际报告的模型。",
  ],
  [
    "给我看具体日志和代码",
    "```js\nconst value = 1;\nconsole.log(value);\n```\n验证尚未完成。",
  ],
  ["写首诗", "窗外落着雨\n灯下翻着书"],
  ["写一个求和函数", "```js\nfunction sum(a, b) {\n  return a + b;\n}\n```"],
] as const) {
  test(`explicit layout survives the actual send boundary: ${request}`, async () => {
    const f = await fixture();
    await f.router.receive(incoming("structured", request));
    await f.decide("structured", { reply: answer });
    await f.notices.flush();
    assert.deepEqual(
      f.channel.sent.map((d) => d.text),
      [answer],
    );
    assert.equal(
      f.store.all<Delivery>("notification_deliveries").find((d) => !d.receipt)!
        .layout,
      "structured",
    );
  });
}

test("negative format preferences and complaints are not list requests", () => {
  for (const request of [
    "不要分点，给我一段话",
    "这份列表看不懂，讲简单点",
    "不要每次写详细报告",
    "每次都分点有点烦",
  ]) {
    assert.equal(replyLayout(request), "paragraph", request);
    assert.equal(
      conciseReply("好的。\n- 这个改动还没生效。\n- 等重启后再检查。", request),
      "这个改动还没生效。 等重启后再检查。",
    );
  }
  assert.equal(
    conciseReply(
      "1. 已修改通知。\n2. 内部执行说明：PRIVATE\n3. 服务尚未重启。",
      "进展呢",
    ),
    "已修改通知。 服务尚未重启。",
  );
  assert.equal(
    conciseReply("- 项目甲\n- 项目乙\n- 内部执行说明：PRIVATE", "列出项目"),
    "- 项目甲\n- 项目乙",
  );
  const long = conciseReply(
    "- 已修改一项通知\n".repeat(80) + "- 服务尚未重启",
    "进展呢",
  );
  assert.ok(long.length <= 360);
  assert.doesNotMatch(long, /\n/);
  assert.match(long, /尚未重启/);
});

test("fast command handoffs vary, cancel delayed receipts and never repeat", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    const message = incoming(`run-${i}`, `/run 项目 | 整理第 ${i} 份资料`);
    await f.router.receive(message);
    await f.router.receive(message);
    await f.notices.flush(Date.now() + 1000);
  }
  assert.equal(f.channel.sent.length, 3);
  assert.equal(new Set(f.channel.sent.map((d) => d.text)).size, 3);
  for (const d of f.channel.sent)
    assert.doesNotMatch(d.text, /整理|已启动|已完成|开始和完成/);
});

test("queued old replies are migrated without changing requested structure or borrowing another user's request", async () => {
  const f = await fixture();
  for (const [id, userId] of [
    ["own", "owner"],
    ["other", "another-user"],
  ]) {
    f.store.put<StoredMessage>("messages", {
      ...incoming(id!, "给我清单"),
      userId: userId!,
      status: "processed",
      receivedAt: 1,
    });
    f.store.put<Delivery>("notification_deliveries", {
      id: id!,
      userId: "owner",
      text: "- 第一项\n- 第二项",
      dedupeKey: `reply:${id}`,
      kind: "reply",
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: id === "own" ? 1 : 2,
      clientVisible: false,
      policyRevision: 1,
    });
  }
  await f.notices.flush();
  assert.deepEqual(
    f.channel.sent.map((d) => d.text),
    ["- 第一项\n- 第二项", "第一项。 第二项"],
  );
});

test("prepared conversational history obeys memory deletion and owner isolation", async () => {
  const f = await fixture();
  await f.router.receive(incoming("history", "今天有点累"));
  await f.decide("history", { reply: "- 那就歇会儿。\n- 不急着找事做。" });
  const q = f.store.all<any>("questions")[0];
  f.store.put("questions", {
    ...q,
    id: "foreign",
    userId: "someone-else",
    replyText: "FOREIGN",
  });
  assert.deepEqual(
    f.dispatcher.context("owner").recentResults.map((q) => q.result),
    ["那就歇会儿。 不急着找事做。"],
  );
  new MemoryManager(f.store).clear("owner", true);
  assert.deepEqual(f.dispatcher.context("owner").recentResults, []);
});

test("compact backend context retains late limitations and leaves detailed evidence available", async () => {
  const f = await fixture();
  const task = f.tasks.create(f.project.id, "优化通知");
  task.summary =
    "已完成初步修改。".repeat(100) + "服务尚未重启，实际模型尚未核实。";
  f.store.put("tasks", task);
  const brief = f.dispatcher.context("owner").tasks[0]!.summary!;
  assert.ok(brief.length <= 360);
  assert.match(brief, /尚未重启/);
  assert.match(brief, /模型尚未核实/);
  assert.equal(
    f.dispatcher.context("owner", true).tasks[0]!.summary,
    task.summary,
  );
});
