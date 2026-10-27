import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { ThreadContinuation } from "../src/codex/continuation.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";
import { MockCodex } from "../src/codex/mock.js";
import { createApi } from "../src/api/server.js";
import { Bridge } from "../src/app/bridge.js";
import type { Task } from "../src/app/types.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { Store } from "../src/storage/store.js";
import { NotificationManager } from "../src/notifications/outbox.js";

const threadId = "01a16be0-b44b-72f0-9642-4fb5585ecd83";
async function setup(t: test.TestContext) {
  const f = await fixture();
  t.after(() => f.store.close());
  f.config.executionAuthorization = "bound-user";
  f.project.codexProjectId = "literature";
  f.project.name = "文献打包";
  f.store.put("projects", f.project);
  f.codex.projects.set("literature", {
    id: "literature",
    name: f.project.name,
    roots: [{ path: f.project.path }],
  });
  f.codex.threads.set(threadId, {
    id: threadId,
    name: "1",
    projectId: "literature",
    cwd: f.project.path,
    status: { type: "idle" },
    turns: [
      {
        id: "old",
        status: "completed",
        items: [{ type: "agentMessage", text: "先核查交接记录，勿重复推送" }],
      },
    ],
  });
  const service = new ThreadContinuation(f.store, f.tasks, f.codex);
  const input = {
    requestId: "once",
    projectId: f.project.id,
    threadId,
    text: "先核对最新交接，只继续尚未完成的覆盖和 Git 同步；保留备份，不强推",
    model: "6.1sol",
  };
  const current = () => service.status("owner", input.requestId);
  return { ...f, service, input, current };
}

for (const selection of ["id", "name"] as const)
  test(`continue by exact ${selection} appends to original ID, preserves history and model`, async (t) => {
    const f = await setup(t);
    await f.service.submit("owner", {
      ...f.input,
      threadId: selection === "id" ? threadId : undefined,
      threadName: selection === "name" ? "1" : undefined,
    });
    assert.equal(f.current().threadId, undefined);
    await f.tasks.pump();
    const task = f.current();
    assert.equal(task.threadId, threadId);
    assert.equal(task.executionModel, "gpt-6.1-sol");
    assert.equal(task.requestedModel, "6.1sol");
    assert.ok(task.turnId && task.targetResumedAt && task.dispatchAttemptId);
    const start = f.codex.calls.find((c) => c.method === "turn/start")!;
    assert.equal(start.params.clientUserMessageId, task.dispatchAttemptId);
    assert.equal(start.params.model, "gpt-6.1-sol");
    assert.equal(start.params.threadId, threadId);
    assert.ok(
      !f.codex.calls.some((c) =>
        ["thread/start", "thread/fork"].includes(c.method),
      ),
    );
    assert.equal(f.codex.threads.get(threadId).turns[0].id, "old");
  });

test("authenticated API exposes inspect/continue/status, rejects CSRF and concurrent duplicate submissions", async (t) => {
  const f = await setup(t);
  const bridge = new Bridge(f.config, {
    store: f.store,
    codex: f.codex,
    channel: f.channel,
  });
  const server = createApi(bridge, 33518);
  await new Promise<void>((resolve) =>
    server.listen(33518, "127.0.0.1", resolve),
  );
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = "http://127.0.0.1:33518";
  assert.equal(
    (await fetch(base + "/api/sessions/continue", { method: "POST" })).status,
    403,
  );
  const boot = (await (await fetch(base + "/api/bootstrap")).json()) as any;
  const headers = {
    "X-Bridge-Token": boot.csrf,
    "Content-Type": "application/json",
  };
  const post = async (route: string, body: unknown) => {
    const response = await fetch(base + "/api/sessions/" + route, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const inspected = await post("inspect", f.input);
  assert.equal(inspected.status, 200);
  assert.match(inspected.data.turns[0].messages[0].text, /交接/);
  const request = {
    ...f.input,
    expectedHistoryRevision: inspected.data.historyRevision,
  };
  const results = await Promise.all([
    post("continue", request),
    post("continue", request),
  ]);
  assert.equal(results[0]!.data.task.id, results[1]!.data.task.id);
  assert.equal(results[0]!.data.resumed, false);
  assert.equal(bridge.tasks.tasks().length, 1);
  await bridge.tasks.pump();
  const status = await post("continuation/status", { requestId: "once" });
  assert.equal(status.data.task.threadId, threadId);
  assert.equal(status.data.task.status, "RUNNING");
  assert.notEqual(
    (await post("continue", { ...request, text: "different work" })).status,
    200,
  );
  const state = (await (
    await fetch(base + "/api/state", { headers })
  ).json()) as any;
  assert.equal(
    state.capabilities.originalThreadContinuation,
    "original-thread-v1",
  );
});

test("history changed after inspection blocks overwrite before resume/start", async (t) => {
  const f = await setup(t);
  const inspected = await f.service.inspect("owner", f.input);
  await f.service.submit("owner", {
    ...f.input,
    expectedHistoryRevision: inspected.historyRevision,
  });
  f.codex.threads.get(threadId).turns.push({
    id: "external",
    status: "completed",
    items: [{ type: "agentMessage", text: "其他客户端已经推送完成" }],
  });
  await f.tasks.pump();
  assert.equal(f.current().status, "FAILED");
  assert.match(f.current().error!, /新进展/);
  assert.ok(
    !f.codex.calls.some((c) =>
      ["thread/resume", "turn/start"].includes(c.method),
    ),
  );
});

test("idle metadata with active history waits, queued work survives orchestrator restart", async (t) => {
  const f = await setup(t);
  f.codex.threads
    .get(threadId)
    .turns.push({ id: "external", status: "inProgress", items: [] });
  await f.service.submit("owner", f.input);
  await f.tasks.pump();
  assert.equal(f.current().status, "QUEUED");
  assert.ok(!f.codex.calls.some((c) => c.method === "turn/start"));
  const replacement = new TaskOrchestrator(
    f.store,
    f.codex,
    f.notices,
    f.config,
  );
  replacement.recover();
  f.codex.threads.get(threadId).turns.at(-1).status = "completed";
  const queued = f.current();
  queued.targetCheckAfter = 0;
  f.store.put("tasks", queued);
  await replacement.pump();
  assert.equal(f.current().threadId, threadId);
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    1,
  );
});

for (const outcome of ["completed", "failed", "interrupted"])
  test(`restart recovers original ${outcome} result without replay or duplicate notice`, async (t) => {
    const f = await setup(t);
    await f.service.submit("owner", f.input);
    await f.tasks.pump();
    const before = f.current();
    const codex = new MockCodex();
    await codex.connect();
    codex.projects = f.codex.projects;
    codex.threads = f.codex.threads;
    codex.threads.get(threadId).turns.push({
      id: before.turnId,
      status: outcome,
      items: [
        {
          type: "agentMessage",
          text: JSON.stringify({
            summary: "原轮次结果",
            userMessage: "结果已核对，细节留在后台。",
          }),
        },
      ],
    });
    const restored = new TaskOrchestrator(f.store, codex, f.notices, f.config);
    restored.recover();
    await restored.reconcile();
    const current = f.current();
    assert.equal(current.status, outcome.toUpperCase());
    assert.equal(current.summary, "原轮次结果");
    assert.equal(current.turnId, before.turnId);
    const evidence = f.store.get<any>(
      "inference_records",
      `${threadId}:${before.turnId}`,
    )!;
    assert.equal(evidence.requestedModel, "gpt-6.1-sol");
    assert.equal(evidence.actualModel, null);
    assert.equal(evidence.billingSource, "unknown");
    await restored.reconcile();
    await restored.pump();
    assert.ok(
      !codex.calls.some((c) =>
        ["turn/start", "thread/resume", "thread/fork"].includes(c.method),
      ),
    );
    assert.equal(
      f.store
        .all<any>("notification_deliveries")
        .filter((d) => d.dedupeKey === `finished:${before.id}`).length,
      1,
    );
  });

test("lost start acknowledgement reconciles by official client message ID, never by a nearby turn", async (t) => {
  const f = await setup(t);
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params = {}) => {
    if (method === "turn/start") {
      f.codex.threads.get(threadId).turns.push({
        id: "ours",
        status: "completed",
        items: [
          {
            type: "userMessage",
            clientId: params.clientUserMessageId,
            content: params.input,
          },
        ],
      });
      throw new Error("response lost");
    }
    return request(method, params);
  };
  await f.service.submit("owner", f.input);
  await f.tasks.pump();
  assert.equal(f.current().status, "UNKNOWN");
  assert.equal(f.current().turnId, undefined);
  await f.tasks.reconcile();
  assert.equal(f.current().status, "COMPLETED");
  assert.equal(f.current().turnId, "ours");
  assert.equal((await f.service.submit("owner", f.input)).id, f.current().id);
});

test("unknown acceptance with missing evidence stays blocked across recovery and duplicate calls", async (t) => {
  const f = await setup(t);
  const request = f.codex.request.bind(f.codex);
  let starts = 0;
  f.codex.request = async (method, params = {}) => {
    if (method === "turn/start") {
      starts++;
      throw new Error("connection lost");
    }
    return request(method, params);
  };
  await f.service.submit("owner", f.input);
  await f.tasks.pump();
  f.tasks.recover();
  await f.tasks.reconcile();
  await new ThreadContinuation(f.store, f.tasks, f.codex).submit(
    "owner",
    f.input,
  );
  await f.tasks.pump();
  assert.equal(f.current().status, "UNKNOWN");
  assert.equal(starts, 1);
  assert.match(f.current().reconciliationNote!, /无法唯一确认/);
});

test("disk restart retains queued binding, original idempotency key and uncertain dispatch identity", async (t) => {
  const f = await setup(t);
  const root = path.resolve(".test-tmp");
  mkdirSync(root, { recursive: true });
  const file = path.join(
    mkdtempSync(path.join(root, "continuation-")),
    "bridge.sqlite",
  );
  let store = new Store(file);
  store.setSetting("boundUser", "owner");
  store.put("projects", f.project);
  let tasks = new TaskOrchestrator(
    store,
    f.codex,
    new NotificationManager(store, f.channel),
    f.config,
  );
  let service = new ThreadContinuation(store, tasks, f.codex);
  const queued = await service.submit("owner", f.input);
  store.close();
  store = new Store(file);
  tasks = new TaskOrchestrator(
    store,
    f.codex,
    new NotificationManager(store, f.channel),
    f.config,
  );
  service = new ThreadContinuation(store, tasks, f.codex);
  tasks.recover();
  assert.equal((await service.submit("owner", f.input)).id, queued.id);
  await tasks.pump();
  const running = service.status("owner", "once");
  assert.equal(running.threadId, threadId);
  store.close();
  store = new Store(file);
  const recoveryCodex = new MockCodex();
  await recoveryCodex.connect();
  recoveryCodex.projects = f.codex.projects;
  recoveryCodex.threads = f.codex.threads;
  tasks = new TaskOrchestrator(
    store,
    recoveryCodex,
    new NotificationManager(store, f.channel),
    f.config,
  );
  tasks.recover();
  await tasks.reconcile();
  await tasks.pump();
  const recovered = store.get<Task>("tasks", queued.id)!;
  assert.equal(recovered.status, "UNKNOWN");
  assert.equal(recovered.dispatchAttemptId, running.dispatchAttemptId);
  assert.equal(recovered.turnId, running.turnId);
  assert.ok(!recoveryCodex.calls.some((c) => c.method === "turn/start"));
  store.close();
});

test("early foreign events cannot claim an original-thread task while start response is pending", async (t) => {
  const f = await setup(t);
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params = {}) => {
    if (method === "turn/start") {
      for (const id of ["other-client", "ours"]) {
        f.codex.emit("item/completed", {
          threadId,
          turnId: id,
          item: { type: "agentMessage", text: id },
        });
        f.codex.emit("turn/completed", {
          threadId,
          turn: { id, status: "completed" },
        });
      }
      await f.tasks.drained();
      return { turn: { id: "ours", status: "inProgress" } } as any;
    }
    return request(method, params);
  };
  await f.service.submit("owner", f.input);
  await f.tasks.pump();
  await f.tasks.drained();
  assert.equal(f.current().turnId, "ours");
  assert.equal(f.current().summary, "ours");
});

test("duplicate names require ID; cross-project and cross-user requests cannot resume", async (t) => {
  const f = await setup(t);
  f.codex.threads.set("duplicate", {
    ...f.codex.threads.get(threadId),
    id: "duplicate",
  });
  await assert.rejects(
    f.service.submit("owner", {
      ...f.input,
      threadId: undefined,
      threadName: "1",
    }),
    /多个/,
  );
  f.codex.threads.get("duplicate").projectId = "foreign-project";
  await assert.rejects(
    f.service.submit("owner", { ...f.input, threadId: "duplicate" }),
    /没有找到/,
  );
  await f.service.submit("owner", f.input);
  f.store.setSetting("boundUser", "another-user");
  await assert.rejects(f.service.submit("owner", f.input), /绑定用户/);
  assert.throws(
    () => f.service.status("another-user", f.input.requestId),
    /没有找到/,
  );
  assert.ok(!f.codex.calls.some((c) => c.method === "turn/start"));
});

for (const failure of [
  "resume-unsupported",
  "model-unavailable",
  "model-mismatch",
])
  test(`${failure} fails explicitly without a substitute thread/model`, async (t) => {
    const f = await setup(t);
    const request = f.codex.request.bind(f.codex);
    f.codex.request = async (method, params = {}) => {
      if (method === "thread/resume" && failure === "resume-unsupported")
        throw new Error("Codex RPC -32601: method not found");
      if (method === "model/list" && failure === "model-unavailable")
        return { data: [], nextCursor: null } as any;
      const result = await request<any>(method, params);
      if (method === "thread/resume" && failure === "model-mismatch")
        result.model = "other-model";
      return result;
    };
    await f.service.submit("owner", f.input);
    await f.tasks.pump();
    assert.equal(f.current().status, "FAILED");
    assert.ok(f.current().error);
    assert.ok(
      !f.codex.calls.some((c) =>
        ["turn/start", "thread/start", "thread/fork"].includes(c.method),
      ),
    );
  });

test("natural-language continuation retains requested model through project clarification", async (t) => {
  const f = await setup(t);
  for (const [id, text, decision] of [
    [
      "first",
      "让1来覆盖本地并同步 Git，用 6.1sol",
      {
        action: "resolve_target",
        target: {
          requestId: null,
          threadName: "1",
          threadId: null,
          model: "6.1sol",
        },
      },
    ],
    ["clarify", "是文献打包项目", { action: "answer", reply: "好的" }],
  ] as const) {
    await f.router.receive({
      id,
      text,
      userId: "owner",
      sentAt: Date.now(),
      kind: "direct",
    });
    await f.decide(id, decision);
  }
  const task = f.tasks.tasks()[0]!;
  assert.equal(task.requestedModel, "6.1sol");
  assert.equal(task.executionModel, "gpt-6.1-sol");
  assert.equal(task.targetThreadId, threadId);
});

test("resume without explicit direct-input capability never starts a turn", async (t) => {
  const f = await setup(t);
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params = {}) => {
    const result = await request<any>(method, params);
    if (method === "thread/resume") result.thread.canAcceptDirectInput = null;
    return result;
  };
  await f.service.submit("owner", f.input);
  await f.tasks.pump();
  assert.equal(f.current().status, "FAILED");
  assert.match(f.current().error!, /未确认原对话可以接收/);
  assert.ok(!f.codex.calls.some((c) => c.method === "turn/start"));
});
