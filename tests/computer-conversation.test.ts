import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { ComputerService } from "../src/computer/service.js";
import type { Delivery } from "../src/app/types.js";
import type { Question } from "../src/codex/questions.js";
import { INTENT_REVISION } from "../src/app/intent.js";
import { computerCall } from "../src/computer/protocol.js";
import type { ReadRequest } from "../src/computer/reader.js";

function stub(observe: (request: ReadRequest) => Promise<unknown>) {
  return {
    context: () => ({ capabilities: ["discover_apps"] }),
    observe,
    workspaces: {
      list: async () => "发现项目：真实项目",
      snapshot: () => ({ projects: [], workspaces: [] }),
    },
  } as unknown as ComputerService;
}
test("external app data is fed back to Codex before one final reply, without Bridge todo actions", async () => {
  const calls: ReadRequest[] = [];
  const f = await fixture(
    stub(async (request) => {
      calls.push(request);
      return { source: "桌面软件", rows: [{ title: "真实待办" }] };
    }),
  );
  f.questions.enqueue("看看软件里的待办", "owner", "one");
  const q = await f.decide("one", {
    action: "computer",
    computer: computerCall({ tool: "apps", query: "软件" }),
  });
  assert.equal(q.status, "running");
  assert.equal(q.toolCalls?.length, 1);
  assert.equal(f.store.all("notification_deliveries").length, 0);
  const input = JSON.parse(
    f.codex.calls.filter((c) => c.method === "turn/start").at(-1)!.params
      .input[0].text,
  );
  assert.equal(input.computerObservation.result.rows[0].title, "真实待办");
  const final = await f.decide("one", { reply: "软件里有一件：真实待办。" });
  assert.equal(final.status, "completed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { tool: "apps", query: "软件" });
  assert.equal(f.store.all("notification_deliveries").length, 1);
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.todos.list().length, 0);
});
test("duplicate model open requests and old turn completions cannot relaunch the application", async () => {
  let launches = 0;
  const f = await fixture(
    stub(async () => {
      launches++;
      return { status: "launch_requested" };
    }),
  );
  f.questions.enqueue("打开软件", "owner", "one");
  await f.questions.pump();
  const first = f.store.get<Question>("questions", "one")!;
  await f.decide("one", {
    action: "computer",
    computer: computerCall({ tool: "open_app", id: "known" }),
  });
  f.codex.emit("turn/completed", {
    threadId: first.threadId,
    turn: { id: first.turnId, status: "completed" },
  });
  await f.questions.drained();
  await f.decide("one", {
    action: "computer",
    computer: computerCall({ id: "known", tool: "open_app" }),
  });
  assert.equal(launches, 1);
  await f.decide("one", { reply: "已请求打开。" });
  assert.equal(f.store.get<Question>("questions", "one")?.status, "completed");
});
test("tool failure becomes evidence for a truthful answer and bounded loops terminate", async () => {
  const f = await fixture(
    stub(async () => {
      throw new Error("数据文件不存在");
    }),
  );
  f.questions.enqueue("查数据", "owner", "one");
  for (let i = 0; i < 12; i++) {
    const q = await f.decide("one", {
      action: "computer",
      computer: computerCall({ tool: "read_file", id: "x", path: "data.json" }),
    });
    assert.equal(q.status, "running");
    assert.match(JSON.stringify(q.toolCalls?.at(-1)?.result), /数据文件不存在/);
  }
  const final = await f.decide("one", {
    action: "computer",
    computer: computerCall({ tool: "apps" }),
  });
  assert.equal(final.status, "failed");
  assert.equal(final.toolCalls?.length, 12);
  assert.match(final.answer!, /上限/);
});
test("12 second processing stays silent and recover cancels obsolete canned notifications", async () => {
  const f = await fixture();
  f.questions.enqueue("普通问题", "owner", "one");
  await f.questions.pump();
  f.questions.monitor(Date.now() + 13000);
  assert.equal(f.store.all("notification_deliveries").length, 0);
  f.notices.enqueue("旧提示", "answer-wait:old");
  f.questions.recover();
  assert.equal(
    f.store
      .all<Delivery>("notification_deliveries")
      .find((d) => d.dedupeKey === "answer-wait:old")?.status,
    "cancelled",
  );
});
test("discovered project list is queried when no Bridge projects are registered", async () => {
  const f = await fixture(stub(async () => ({})));
  f.store.delete("projects", f.project.id);
  f.questions.enqueue("我有哪些项目", "owner", "one");
  const q = await f.decide("one", { action: "list_projects" });
  assert.match(q.answer!, /真实项目/);
  assert.doesNotMatch(q.answer!, /没有接入/);
});

test("plaintext computer decisions are repaired internally before structured execution and one final answer", async () => {
  const calls: ReadRequest[] = [];
  const f = await fixture(
    stub(async (request) => {
      calls.push(request);
      return { apps: [{ id: "actual-app", name: "软件" }] };
    }),
  );
  f.questions.enqueue("看看软件里的信息", "owner", "one");
  const repairing = await f.decide("one", {
    action: "computer",
    text: "查找软件，读取今天的待办",
    computer: null,
  });
  assert.equal(repairing.status, "running");
  assert.equal(repairing.repairAttempts, 1);
  assert.equal(calls.length, 0);
  assert.equal(f.store.all("notification_deliveries").length, 0);
  const input = JSON.parse(
    f.codex.calls.filter((c) => c.method === "turn/start").at(-1)!.params
      .input[0].text,
  );
  assert.equal(input.computerObservation.kind, "decision_format_repair");
  assert.equal(input.userMessage, "看看软件里的信息");
  await f.decide("one", {
    action: "computer",
    computer: computerCall({ tool: "apps", query: "软件" }),
  });
  assert.deepEqual(calls, [{ tool: "apps", query: "软件" }]);
  assert.equal(f.store.all("notification_deliveries").length, 0);
  const final = await f.decide("one", {
    reply: "找到了软件，实际名称是软件。",
  });
  assert.equal(final.status, "completed");
  assert.equal(final.answer, "找到了软件，实际名称是软件。");
  assert.equal(f.store.all<Delivery>("notification_deliveries").length, 1);
  assert.equal(
    f.store.all<Delivery>("notification_deliveries")[0]!.text,
    final.answer,
  );
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.todos.list().length, 0);
});

test("protocol upgrades replace old analysis sessions without changing the bound account", async () => {
  for (const protocol of [null, "legacy-text-computer-v1"]) {
    const f = await fixture();
    f.store.setSetting("qa-session:owner", "old-analysis-thread");
    if (protocol !== null) f.store.setSetting("qa-protocol:owner", protocol);
    f.store.put("codex_sessions", {
      id: "old-analysis-thread",
      origin: "qa",
      userId: "owner",
    });
    f.questions.enqueue("继续看看项目", "owner", "one");
    const q = await f.decide("one", { reply: "新协议的回答。" });
    assert.equal(q.status, "completed");
    assert.equal(q.protocolVersion, INTENT_REVISION);
    assert.notEqual(q.threadId, "old-analysis-thread");
    assert.ok(f.codex.calls.some((c) => c.method === "thread/start"));
    assert.ok(!f.codex.calls.some((c) => c.method === "thread/resume"));
    assert.equal(f.store.setting("qa-protocol:owner", ""), INTENT_REVISION);
    assert.equal(f.store.setting("qa-session:owner", ""), q.threadId);
    assert.equal(f.store.setting("boundUser", ""), "owner");
    assert.deepEqual(f.store.get("codex_sessions", "old-analysis-thread"), {
      id: "old-analysis-thread",
      origin: "qa",
      userId: "owner",
      ownerId: "owner",
    });
    assert.ok(
      !f.codex.calls.some((c) => /login|logout|auth|bind/.test(c.method)),
    );
  }
});
