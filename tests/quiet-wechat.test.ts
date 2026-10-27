import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { Delivery, Task, StoredMessage } from "../src/app/types.js";
import type { Question } from "../src/codex/questions.js";
import {
  wantsReceipt,
  RECEIPT_DELAY_MS,
} from "../src/notifications/presentation.js";
import { conciseReply } from "../src/notifications/task-message.js";
import { messageLatency, distribution } from "../src/notifications/latency.js";
import { DeliveryUncertainError } from "../src/channels/wechat/ilink.js";

const incoming = (id: string, text = "帮我优化项目里的通知功能") => ({
  id,
  text,
  userId: "owner",
  sentAt: Date.now(),
  kind: "direct" as const,
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
const deliveries = (f: Fixture) =>
  f.store.all<Delivery>("notification_deliveries");

test("receipt is durable, delayed, independent of model, deduplicated and never claims start", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture();
  const message = incoming("slow");
  await f.router.receive(message);
  await f.router.receive(message);
  assert.equal(
    f.store.get<StoredMessage>("messages", message.id)!.status,
    "processed",
  );
  assert.equal(
    f.store.get<Question>("questions", message.id)!.status,
    "queued",
  );
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    0,
  );
  now += RECEIPT_DELAY_MS - 1;
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 0);
  now++;
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 1);
  assert.match(f.channel.sent[0]!.text, /收到/);
  assert.doesNotMatch(
    f.channel.sent[0]!.text,
    /启动|开始|已交给|已完成|通知功能/,
  );
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 1);

  await f.decide("slow", {
    action: "run",
    projectId: f.project.id,
    text: message.text,
  });
  await f.tasks.pump();
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 1, "no duplicate dispatch/start notice");
  assert.ok(
    deliveries(f).some(
      (d) =>
        d.dedupeKey.startsWith("start:") &&
        d.backendOnly &&
        d.detailText!.includes(message.text),
    ),
  );
  const task = f.tasks.tasks()[0]!;
  f.codex.emit("item/completed", {
    threadId: task.threadId,
    turnId: task.turnId,
    item: {
      type: "agentMessage",
      text: JSON.stringify({
        summary: "内部技术说明",
        userMessage: "通知已调整，尚未重启生效。",
        files: ["private.ts"],
        tests: ["node test exitCode=0"],
        next: "",
      }),
    },
  });
  f.codex.emit("turn/completed", {
    threadId: task.threadId,
    turn: { id: task.turnId, status: "completed" },
  });
  await f.tasks.drained();
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 2);
  assert.match(f.channel.sent[1]!.text, /尚未重启/);
  assert.doesNotMatch(f.channel.sent[1]!.text, /内部技术|private|exitCode/);
});

test("fast answers and clarification cancel pending receipt before it can send", async () => {
  const f = await fixture();
  await f.router.receive(incoming("fast"));
  await f.decide("fast", { reply: "要修改哪个项目的通知？" });
  await f.notices.flush(Date.now() + 1000);
  assert.deepEqual(
    f.channel.sent.map((d) => d.text),
    ["要修改哪个项目的通知？"],
  );
  assert.equal(deliveries(f).find((d) => d.receipt)!.status, "cancelled");
});

test("chitchat, quick questions and quoted tasks never mechanically get processing receipts", async () => {
  const f = await fixture();
  for (const [i, text] of [
    "你好穆戈",
    "谢谢",
    "现在几点",
    "怎么创建项目？",
    "帮我解释这段代码",
    "有哪些优化建议",
  ].entries()) {
    assert.equal(wantsReceipt(text), false, text);
    await f.router.receive(incoming(`chat-${i}`, text));
  }
  await f.router.receive({ ...incoming("forward"), kind: "forwarded" });
  await f.notices.flush(Date.now() + 20_000);
  assert.equal(deliveries(f).filter((d) => d.receipt).length, 0);
  assert.equal(f.tasks.tasks().length, 0);
});

test("a later validated long dispatch gets a receipt even if the local timing hint was unclear", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture();
  await f.router.receive(incoming("ambiguous", "把刚才那个改一下"));
  assert.equal(deliveries(f).length, 0);
  now += 2000;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const execute = f.dispatcher.execute.bind(f.dispatcher);
  t.mock.method(
    f.dispatcher,
    "execute",
    async (...args: Parameters<typeof execute>) => {
      await gate;
      return execute(...args);
    },
  );
  const done = f.decide("ambiguous", {
    action: "run",
    projectId: f.project.id,
    text: "修改刚才的功能",
  });
  for (
    let i = 0;
    i < 20 &&
    f.store.get<Question>("questions", "ambiguous")?.status !== "dispatching";
    i++
  )
    await new Promise<void>((resolve) => setImmediate(resolve));
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 1);
  release();
  await done;
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 1);
});

test("an in-flight receipt cannot be overtaken by a final answer", async (t) => {
  const f = await fixture();
  await f.router.receive(incoming("race"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = f.channel.sendMessage.bind(f.channel);
  t.mock.method(
    f.channel,
    "sendMessage",
    async (...args: Parameters<typeof send>) => {
      await gate;
      return send(...args);
    },
  );
  const flushing = f.notices.flush(Date.now() + 1000);
  await f.decide("race", { reply: "需要先确认项目名称。" });
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 0);
  release();
  await flushing;
  await f.notices.flush();
  assert.deepEqual(
    f.channel.sent.map((d) => d.text),
    ["收到了，我处理一下。", "需要先确认项目名称。"],
  );
});

test("receipts expire, coalesce bursts, vary wording and do not replay after restart", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = await fixture();
  await f.router.receive(incoming("one"));
  now += 100;
  await f.router.receive(incoming("two"));
  now += 800;
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 1);
  assert.equal(
    deliveries(f).find((d) => d.messageId === "one")!.status,
    "cancelled",
  );
  now += 10_000;
  await f.router.receive(incoming("three"));
  now += 800;
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 2);
  assert.notEqual(f.channel.sent[0]!.text, f.channel.sent[1]!.text);
  now += 10_000;
  await f.router.receive(incoming("four"));
  f.notices.recover();
  await f.notices.flush(now + 1000);
  assert.equal(f.channel.sent.length, 2);
  await f.router.receive(incoming("five"));
  await f.notices.flush(now + 16_000);
  assert.equal(f.channel.sent.length, 2);
});

test("unauthorized, stale and rebound messages cannot receive a work receipt", async () => {
  const f = await fixture();
  await f.router.receive({ ...incoming("other"), userId: "other" });
  await f.router.receive({ ...incoming("stale"), sentAt: 0 });
  assert.equal(deliveries(f).filter((d) => d.receipt).length, 0);
  await f.router.receive(incoming("rebound"));
  f.store.setSetting("boundUser", "new-owner");
  await f.notices.flush(Date.now() + 1000);
  assert.equal(f.channel.sent.length, 0);
});

for (const uncertain of [false, true])
  test(`failed receipt never retries (${uncertain ? "uncertain" : "definite"})`, async (t) => {
    const f = await fixture();
    let sends = 0;
    t.mock.method(f.channel, "sendMessage", async () => {
      sends++;
      throw uncertain
        ? new DeliveryUncertainError("unknown")
        : new Error("offline");
    });
    await f.router.receive(incoming("failed"));
    await f.notices.flush(Date.now() + 1000);
    await f.notices.flush(Date.now() + 10_000);
    assert.equal(sends, 1);
    assert.equal(
      deliveries(f)[0]!.status,
      uncertain ? "delivery_unverified" : "failed",
    );
  });

test("retrying substantive replies retain FIFO, including equal creation timestamps", async (t) => {
  const f = await fixture();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const send = f.channel.sendMessage.bind(f.channel);
  let count = 0;
  t.mock.method(
    f.channel,
    "sendMessage",
    async (...args: Parameters<typeof send>) => {
      if (++count === 1) throw new Error("offline");
      return send(...args);
    },
  );
  f.notices.enqueue("第一条", "answer:first", "owner", "reply");
  f.notices.enqueue("第二条", "answer:second", "owner", "reply");
  await f.notices.flush();
  await f.notices.flush(now + 1000);
  assert.equal(f.channel.sent.length, 0);
  await f.notices.flush(now + 5000);
  assert.deepEqual(
    f.channel.sent.map((d) => d.text),
    ["第一条", "第二条"],
  );
});

test("legacy dispatch, progress, approval and exception deliveries are cleaned at actual send boundary", async () => {
  const f = await fixture();
  const text =
    "收到，已交给“项目”：完整任务文本 SECRET_INSTRUCTIONS\n开始和完成时我会告诉你。";
  f.store.put<Delivery>("notification_deliveries", {
    id: "legacy",
    userId: "owner",
    text,
    dedupeKey: "answer:legacy",
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    clientVisible: false,
  });
  for (const key of [
    "start:task",
    "phase:task",
    "approval:one",
    "stale:task",
    "start-error:task",
    "timeout:task",
    "boundary-unknown:task",
    "unsupported:task",
  ])
    f.notices.enqueue(
      "SECRET_INSTRUCTIONS\nRPC -32603 at internal.ts stack\nD:\\private\\data",
      key,
    );
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 7);
  for (const sent of f.channel.sent)
    assert.doesNotMatch(
      sent.text,
      /SECRET|RPC|internal|private|完整任务|开始和完成/,
    );
  assert.equal(
    f.store.get<Delivery>("notification_deliveries", "legacy")!.detailText,
    text,
  );
});

test("task result does not precede creation result and supersedes redundant dispatch acknowledgement", async () => {
  const f = await fixture();
  f.store.put("questions", {
    id: "create",
    userId: "owner",
    status: "dispatching",
  });
  f.notices.enqueue(
    "任务完成了。",
    "finished:created",
    "owner",
    "notification",
    undefined,
    { messageId: "create" },
  );
  await f.notices.flush();
  assert.equal(f.channel.sent.length, 0);
  f.store.put("questions", {
    id: "create",
    userId: "owner",
    status: "completed",
  });
  f.notices.reply(
    "已创建项目，项目 ID：official-real-id",
    "answer:create",
    "owner",
    "create",
  );
  await f.notices.flush();
  await f.notices.flush();
  assert.deepEqual(
    f.channel.sent.map((d) => d.text),
    ["已创建项目，项目 ID：official-real-id", "任务完成了。"],
  );
  f.notices.enqueue(
    "已处理完。",
    "finished:fast",
    "owner",
    "notification",
    undefined,
    { messageId: "fast" },
  );
  f.notices.reply("收到了，我处理一下。", "answer:fast", "owner", "fast", true);
  await f.notices.flush();
  assert.equal(f.channel.sent.at(-1)!.text, "已处理完。");
});

test("details remain available only when explicitly requested", () => {
  const full =
    "通知已调整。\n内部执行说明：PRIVATE_DETAILS\n```js\nconsole.log('demo')\n```\n服务尚未重启。";
  const short = conciseReply(full, "进展如何");
  assert.match(short, /尚未重启/);
  assert.doesNotMatch(short, /PRIVATE|console/);
  assert.equal(conciseReply(full, "给我看具体日志和技术细节"), full);
});

test("latency reports use measured timestamp pairs and exclude another user's records", async () => {
  assert.equal(distribution([2, 8, 6, 4]).medianMs, 5);
  const f = await fixture();
  f.store.put<StoredMessage>("messages", {
    ...incoming("metric"),
    sentAt: 0,
    transportReceivedAt: 100,
    receivedAt: 105,
    routedAt: 112,
    status: "processed",
  });
  f.store.put<Question>("questions", {
    id: "metric",
    userId: "owner",
    text: "test",
    status: "completed",
    createdAt: 105,
    startedAt: 120,
    preparedAt: 200,
    decisionAt: 1000,
    endedAt: 1050,
    turnTimings: [{ startedAt: 200, acceptedAt: 220, completedAt: 1000 }],
  });
  f.store.put<Question>("questions", {
    id: "hidden",
    userId: "another",
    text: "hidden",
    status: "completed",
    createdAt: 1,
    startedAt: 2,
    endedAt: 99999,
  });
  const metrics = messageLatency(f.store);
  assert.equal(metrics.ingress.medianMs, 5);
  assert.equal(metrics.routing.medianMs, 7);
  assert.equal(metrics.queue.medianMs, 15);
  assert.equal(metrics.preparation.medianMs, 80);
  assert.equal(metrics.modelRound.medianMs, 800);
  assert.equal(metrics.dispatch.medianMs, 50);
  assert.equal(metrics.queue.samples, 1);
  assert.equal(metrics.sendRequest.medianMs, null);
});
