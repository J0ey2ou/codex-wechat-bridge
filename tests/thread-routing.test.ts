import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import type { Task } from "../src/app/types.js";
import type { Intent } from "../src/app/intent.js";
import { ThreadTargets } from "../src/codex/thread-target.js";
import {
  TargetRouting,
  threadNameHint,
  type RoutingRequest,
} from "../src/app/target-routing.js";
import { WorkspaceCatalog } from "../src/computer/workspaces.js";
import { executionProject } from "../src/computer/projects.js";
import { Store } from "../src/storage/store.js";

const original = "让1来覆盖本地结果，然后同步一轮到git上";
const inbound = (id: string, text: string) => ({
  id,
  text,
  userId: "owner",
  sentAt: Date.now(),
  kind: "direct" as const,
});
const select = (threadName = "1", requestId: string | null = null) => ({
  threadName,
  requestId,
  threadId: null,
});
async function setup(t: test.TestContext) {
  const f = await fixture();
  t.after(() => f.store.close());
  Object.assign(f.project, { name: "文献打包", codexProjectId: "literature" });
  f.store.put("projects", f.project);
  f.codex.projects.set("literature", {
    id: "literature",
    name: "文献打包",
    roots: [{ path: f.project.path }],
  });
  f.codex.threads.set("literature-one", {
    id: "literature-one",
    name: "1",
    projectId: "literature",
    cwd: f.project.path,
    status: { type: "idle" },
    turns: [
      {
        id: "prior-turn",
        status: "completed",
        items: [{ type: "agentMessage", text: "已有上下文" }],
      },
    ],
  });
  const call = async (id: string, text: string, decision: Partial<Intent>) => {
    await f.router.receive(inbound(id, text));
    return f.decide(id, decision);
  };
  const target = (name = "1"): Partial<Intent> => ({
    action: "resolve_target",
    projectId: f.project.id,
    target: select(name),
    text: original,
  });
  const finish = async (task: Task) => {
    f.codex.emit("turn/completed", {
      threadId: task.threadId,
      turn: { id: task.turnId, status: "completed" },
    });
    await f.tasks.drained();
  };
  return { ...f, call, target, finish };
}

test("numeric name survives project clarification and resumes exact history with complete original requirements", async (t) => {
  const f = await setup(t);
  const first = await f.call("request", original, {
    action: "answer",
    reply: "1 是方案还是产物？",
  });
  assert.equal(first.replyText, "这是哪个项目里的对话？");
  assert.equal(f.tasks.tasks().length, 0);
  const second = await f.call("project", "是文献打包项目", {
    action: "answer",
    reply: "先检查文件再说",
  });
  assert.match(second.replyText!, /对话“1”/);
  let task = f.tasks.tasks()[0]!;
  assert.equal(task.targetThreadId, "literature-one");
  assert.equal(task.threadId, undefined, "selection is not a completed resume");
  assert.ok(task.stages[0]!.prompt.includes(original));
  assert.equal(
    task.sourceMessageId,
    "project",
    "completion must wait for the clarification result, not the old question",
  );
  assert.match(task.stages[0]!.prompt, /是文献打包项目/);
  assert.equal(f.store.all("user_memories").length, 0);
  const calls = f.codex.calls.length;
  await f.tasks.pump();
  task = f.tasks.tasks()[0]!;
  assert.equal(task.status, "RUNNING");
  assert.equal(task.threadId, "literature-one");
  assert.ok(task.targetResumedAt);
  const execution = f.codex.calls.slice(calls);
  assert.equal(execution.filter((c) => c.method === "thread/resume").length, 1);
  assert.ok(
    !execution.some((c) =>
      [
        "thread/start",
        "thread/fork",
        "thread/metadata/update",
        "thread/name/set",
      ].includes(c.method),
    ),
  );
  assert.equal(
    execution.find((c) => c.method === "turn/start")!.params.threadId,
    "literature-one",
  );
  assert.ok(
    execution
      .find((c) => c.method === "turn/start")!
      .params.input[0].text.includes(original),
  );
  assert.equal(f.codex.threads.get("literature-one").turns[0].id, "prior-turn");
});

test("short conversation names are valid and plan numbers are not silently treated as threads", async (t) => {
  const f = await setup(t);
  f.codex.threads.get("literature-one").name = "A";
  await f.call("short", "在文献打包的对话 A 里继续整理", f.target("A"));
  assert.equal(f.tasks.tasks()[0]!.targetThreadName, "A");
  assert.equal(threadNameHint("让方案1来覆盖本地结果"), undefined);
  assert.equal(
    threadNameHint("请修复路由，用户说过让1来覆盖本地结果"),
    undefined,
  );
});

test("same title in another project sharing cwd is never selected or read", async (t) => {
  const f = await setup(t);
  f.codex.projects.set("other", {
    id: "other",
    name: "另一个项目",
    roots: [{ path: f.project.path }],
  });
  f.codex.threads.set("other-one", {
    ...f.codex.threads.get("literature-one"),
    id: "other-one",
    projectId: "other",
  });
  await f.call("scoped", original, f.target());
  assert.equal(f.tasks.tasks()[0]!.targetThreadId, "literature-one");
  assert.ok(
    f.codex.calls
      .filter((c) => c.method === "thread/list")
      .every((c) => c.params.projectId === "literature"),
  );
  assert.ok(
    !f.codex.calls.some(
      (c) => c.method === "thread/read" && c.params.threadId === "other-one",
    ),
  );
});

test("legacy desktop conversation with null projectId resumes in its unique canonical workspace", async (t) => {
  const f = await setup(t);
  f.codex.threads.get("literature-one").projectId = null;
  const target = await new ThreadTargets(f.store, f.codex).resolve(
    f.project,
    "owner",
    { threadName: "1" },
  );
  assert.equal(target.membership, "unique-workspace");
  assert.equal(
    target.projectId,
    undefined,
    "never fabricate formal project assignment",
  );
  await f.call("legacy", original, f.target());
  await f.tasks.pump();
  assert.equal(f.tasks.tasks()[0]?.threadId, "literature-one");
  assert.equal(f.tasks.tasks()[0]?.status, "RUNNING");
  assert.equal(f.tasks.project(f.project.id).codexProjectId, "literature");
  assert.ok(!f.codex.calls.some((c) => c.method === "thread/fork"));
});

test("unassigned conversation in a workspace shared by formal projects is not guessed", async (t) => {
  const f = await setup(t);
  f.codex.threads.get("literature-one").projectId = null;
  f.codex.projects.set("second", {
    id: "second",
    name: "另一项目",
    roots: [{ path: f.project.path }],
  });
  await f.call("ambiguous-root", original, f.target());
  assert.equal(f.tasks.tasks().length, 0);
});

test("duplicate names clarify and an ID selection updates the same request without another task", async (t) => {
  const f = await setup(t);
  f.codex.threads.set("literature-two", {
    ...f.codex.threads.get("literature-one"),
    id: "literature-two",
  });
  const q = await f.call("duplicate", original, f.target());
  assert.match(q.replyText!, /多个叫“1”/);
  assert.equal(f.tasks.tasks().length, 0);
  await f.call("choice", "用对话 ID literature-two", {
    ...f.target(),
    target: {
      requestId: "duplicate",
      threadName: null,
      threadId: "literature-two",
    },
  });
  const task = f.tasks.tasks()[0]!;
  assert.equal(task.targetThreadId, "literature-two");
  assert.ok(task.title.includes(original));
  const repeat = await f.call("repeat", "就是对话1", {
    ...f.target(),
    target: {
      requestId: "duplicate",
      threadName: null,
      threadId: "literature-two",
    },
  });
  assert.equal(repeat.status, "completed");
  assert.equal(f.tasks.tasks().length, 1);
});

for (const mode of [
  "missing",
  "inaccessible",
  "wrong-project",
  "foreign-owner",
  "foreign-project",
] as const) {
  test(`target ${mode} fails closed without fallback execution`, async (t) => {
    const f = await setup(t);
    if (mode === "missing") f.codex.threads.delete("literature-one");
    if (mode === "wrong-project")
      f.codex.threads.get("literature-one").projectId = "unrelated";
    if (mode === "foreign-owner") {
      f.store.setSetting("boundUser", "other-user");
      f.store.put("codex_sessions", { id: "literature-one", origin: "bridge" });
      f.store.setSetting("boundUser", "owner");
    }
    if (mode === "foreign-project")
      f.codex.projects.get("literature").metadata = {
        bridgeOwner: createHash("sha256").update("other-user").digest("hex"),
      };
    if (mode === "inaccessible") {
      const base = f.codex.request.bind(f.codex);
      t.mock.method(
        f.codex,
        "request",
        async (method: string, params?: Record<string, unknown>) => {
          if (method === "thread/list") throw new Error("RPC private stack");
          return base(method, params);
        },
      );
    }
    const q = await f.call(mode, original, f.target());
    assert.match(q.replyText!, /没有找到|访问不到|不属于/);
    assert.doesNotMatch(q.replyText!, /private|RPC/);
    assert.equal(f.tasks.tasks().length, 0);
    assert.equal(f.store.all("user_memories").length, 0);
    if (mode.startsWith("foreign"))
      assert.ok(
        !f.codex.calls.some(
          (c) =>
            c.method === "thread/read" &&
            c.params.threadId === "literature-one",
        ),
      );
  });
}

test("all discovery pages are checked before treating a short title as unique", async (t) => {
  const f = await setup(t);
  const base = f.codex.request.bind(f.codex);
  t.mock.method(
    f.codex,
    "request",
    async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "thread/list")
        return {
          data: [
            {
              ...f.codex.threads.get("literature-one"),
              id: params.cursor ? "second" : "first",
            },
          ],
          nextCursor: params.cursor ? null : "next",
        };
      return base(method, params);
    },
  );
  const q = await f.call("pages", original, f.target());
  assert.match(q.replyText!, /多个/);
  assert.equal(f.tasks.tasks().length, 0);
});

test("a duplicate official project name cannot be shadowed by one registered project", async (t) => {
  const f = await setup(t);
  f.codex.projects.set("duplicate-project", {
    id: "duplicate-project",
    name: f.project.name,
    roots: [{ path: f.project.path }],
  });
  const catalog = new WorkspaceCatalog(
    f.codex,
    f.config,
    () => f.tasks.projects(),
    () => "owner",
  );
  await assert.rejects(executionProject(f.tasks, catalog, "文献打包"), /同名/);
  assert.equal(
    (await executionProject(f.tasks, catalog, "literature")).id,
    f.project.id,
  );
  const routing = new TargetRouting(f.store, f.tasks, f.codex, catalog);
  const reply = await routing.handle(
    {
      action: "resolve_target",
      projectId: "literature",
      taskId: null,
      text: original,
      target: select(),
    },
    "在文献打包项目的对话1里继续整理",
    "ambiguous-project",
    "owner",
  );
  assert.match(reply!, /无法唯一|同名/);
  assert.equal(f.tasks.tasks().length, 0);
});

test("repeated delivery and repeated decision are idempotent", async (t) => {
  const f = await setup(t);
  const decision = f.target();
  await f.call("once", original, decision);
  await f.router.receive(inbound("once", original));
  const parsed = f.store.get<any>("questions", "once")!.decision;
  await f.dispatcher.execute(parsed, original, "once", "owner");
  await f.tasks.pump();
  await f.tasks.pump();
  assert.equal(f.tasks.tasks().length, 1);
  assert.equal(
    f.codex.calls.filter(
      (c) =>
        c.method === "turn/start" && c.params.threadId === "literature-one",
    ).length,
    1,
  );
});

test("queued clarification and continue amendments merge while preserving original work", async (t) => {
  const f = await setup(t);
  await f.call("root", original, f.target());
  let task = f.tasks.tasks()[0]!;
  const amended = f.tasks.continue(task.projectId, "同步前再检查差异", {
    taskId: task.id,
    messageId: "extra",
  });
  assert.equal(amended.id, task.id);
  assert.ok(amended.title.includes(original));
  assert.match(amended.title, /同步前再检查差异/);
  f.tasks.continue(task.projectId, "同步前再检查差异", {
    taskId: task.id,
    messageId: "extra",
  });
  assert.equal(f.tasks.tasks().length, 1);
  assert.equal(f.tasks.tasks()[0]!.title.match(/同步前再检查差异/g)?.length, 1);
  await f.call("clarify-again", "就是对话1", {
    ...f.target(),
    target: select("1", "root"),
  });
  assert.match(f.tasks.tasks()[0]!.title, /同步前再检查差异/);
});

test("discussion of a numbered conversation remains an answer without an operational request or receipt", async (t) => {
  const f = await setup(t);
  await f.call("question-only", "让1来覆盖本地结果可以吗？", {
    action: "answer",
    reply: "要看现有结果是否需要保留。",
  });
  await f.notices.flush(Date.now() + 1000);
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.store.all("routing_requests").length, 0);
  assert.deepEqual(
    f.channel.sent.map((m) => m.text),
    ["要看现有结果是否需要保留。"],
  );
});

test("continuing a completed task pins its thread, while a bare continue on an active task creates no extra turn", async (t) => {
  const f = await setup(t);
  await f.call("pin", original, f.target());
  await f.tasks.pump();
  const first = f.tasks.tasks()[0]!;
  assert.equal(
    f.tasks.continue(first.projectId, "继续", {
      taskId: first.id,
      messageId: "bare",
    }).id,
    first.id,
  );
  assert.equal(f.tasks.tasks().length, 1);
  await f.finish(first);
  const next = f.tasks.continue(first.projectId, "检查交付结果", {
    taskId: first.id,
    messageId: "after-completion",
  });
  const project = f.tasks.project(first.projectId);
  project.sessionId = "other-thread";
  project.sessionsByCodexProject = { literature: "other-thread" };
  f.store.put("projects", project);
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", next.id)!.threadId, "literature-one");
});

test("continue addressed by conversation name reaches the existing task even without a Bridge task ID", async (t) => {
  const f = await setup(t);
  await f.call("named-root", original, f.target());
  await f.tasks.pump();
  const first = f.tasks.tasks()[0]!;
  await f.call("named-followup", "在对话1里继续，补充检查结果", {
    action: "continue",
    projectId: f.project.id,
    taskId: null,
    target: select(),
    text: "补充检查结果",
  });
  assert.equal(f.tasks.tasks().length, 2);
  const child = f.tasks.tasks().find((t) => t.id !== first.id)!;
  assert.equal(child.continuesTaskId, first.id);
  assert.equal(child.targetThreadId, "literature-one");
  assert.ok(!child.title.includes(original));
});

test("an explicit target correction after execution has begun never replays the overwrite or Git request", async (t) => {
  const f = await setup(t);
  f.codex.threads.set("thread-two", {
    ...f.codex.threads.get("literature-one"),
    id: "thread-two",
    name: "2",
  });
  await f.call("started", original, f.target());
  await f.tasks.pump();
  const q = await f.call("correction", "改到对话2里面", {
    ...f.target("2"),
    target: select("2", "started"),
  });
  assert.match(q.replyText!, /不能自动换对话重做/);
  assert.equal(f.tasks.tasks().length, 1);
  assert.equal(f.tasks.tasks()[0]!.threadId, "literature-one");
  assert.ok(
    !f.codex.calls.some(
      (c) => c.method === "turn/start" && c.params.threadId === "thread-two",
    ),
  );
});

test("an old owner's pending request cannot be selected by ID after a rebind", async (t) => {
  const f = await setup(t);
  await f.call("old-request", original, {
    action: "answer",
    reply: "哪个项目？",
  });
  f.store.setSetting("boundUser", "new-owner");
  assert.deepEqual(f.dispatcher.routing.context("new-owner"), []);
  await assert.rejects(
    f.dispatcher.routing.handle(
      {
        action: "resolve_target",
        projectId: null,
        taskId: null,
        text: "继续",
        target: select("1", "old-request"),
      },
      "是文献打包项目",
      "new-message",
      "new-owner",
    ),
    /当前用户/,
  );
  assert.equal(f.tasks.tasks().length, 0);
});

test("running continuation uses one serial follow-up and pins the original thread rather than the project's latest session", async (t) => {
  const f = await setup(t);
  await f.call("run", original, f.target());
  await f.tasks.pump();
  const first = f.tasks.tasks()[0]!;
  const next = f.tasks.continue(first.projectId, "补充检查结果", {
    taskId: first.id,
    messageId: "next1",
  });
  const more = f.tasks.continue(first.projectId, "结果只写一段", {
    taskId: first.id,
    messageId: "next2",
  });
  assert.equal(more.id, next.id);
  assert.equal(more.targetThreadId, first.threadId);
  assert.ok(
    !more.title.includes(original),
    "do not replay destructive original work",
  );
  await f.tasks.pump();
  assert.equal(
    f.codex.calls.filter(
      (c) =>
        c.method === "turn/start" && c.params.threadId === "literature-one",
    ).length,
    1,
  );
  const project = f.tasks.project(first.projectId);
  project.sessionId = "wrong-latest";
  project.sessionsByCodexProject = { literature: "wrong-latest" };
  f.store.put("projects", project);
  await f.finish(first);
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", next.id)!.threadId, "literature-one");
  assert.equal(
    f.codex.calls.filter(
      (c) =>
        c.method === "turn/start" && c.params.threadId === "literature-one",
    ).length,
    2,
  );
});

test("an external active conversation waits without steering, interrupting or creating a replacement thread", async (t) => {
  const f = await setup(t);
  f.codex.threads.get("literature-one").status = { type: "active" };
  await f.call("busy", original, f.target());
  const before = f.codex.calls.length;
  await f.tasks.pump();
  let task = f.tasks.tasks()[0]!;
  assert.equal(task.status, "QUEUED");
  assert.match(task.targetWaitReason!, /等待/);
  assert.ok(
    !f.codex.calls
      .slice(before)
      .some((c) =>
        [
          "thread/resume",
          "thread/start",
          "turn/start",
          "turn/steer",
          "turn/interrupt",
        ].includes(c.method),
      ),
  );
  f.codex.threads.get("literature-one").status = { type: "idle" };
  task.targetCheckAfter = 0;
  f.store.put("tasks", task);
  await f.tasks.pump();
  assert.equal(f.tasks.tasks()[0]!.status, "RUNNING");
});

test("membership changing after selection prevents execution and does not repair by moving the thread", async (t) => {
  const f = await setup(t);
  await f.call("moving", original, f.target());
  f.codex.threads.get("literature-one").projectId = "other-project";
  const before = f.codex.calls.length;
  await f.tasks.pump();
  assert.equal(f.tasks.tasks()[0]!.status, "FAILED");
  assert.ok(
    !f.codex.calls
      .slice(before)
      .some((c) =>
        [
          "thread/resume",
          "thread/start",
          "thread/metadata/update",
          "turn/start",
        ].includes(c.method),
      ),
  );
});

test("a wrong resume result cannot redirect the selected conversation", async (t) => {
  const f = await setup(t);
  await f.call("resume", original, f.target());
  const base = f.codex.request.bind(f.codex);
  t.mock.method(
    f.codex,
    "request",
    async (method: string, params?: Record<string, unknown>) => {
      const value = await base(method, params);
      return method === "thread/resume"
        ? { ...value, thread: { ...value.thread, id: "wrong" } }
        : value;
    },
  );
  await f.tasks.pump();
  assert.equal(f.tasks.tasks()[0]!.status, "FAILED");
  assert.ok(
    !f.codex.calls.some(
      (c) => c.method === "turn/start" && c.params.threadId === "wrong",
    ),
  );
});

test("binding change while discovering threads cannot read or dispatch the former user's target", async (t) => {
  const f = await setup(t);
  const base = f.codex.request.bind(f.codex);
  t.mock.method(
    f.codex,
    "request",
    async (method: string, params?: Record<string, unknown>) => {
      const result = await base(method, params);
      if (method === "thread/list") f.store.setSetting("boundUser", "new-user");
      return result;
    },
  );
  await assert.rejects(
    new ThreadTargets(f.store, f.codex).resolve(f.project, "owner", {
      threadName: "1",
    }),
    /绑定/,
  );
  assert.ok(!f.codex.calls.some((c) => c.method === "thread/read"));
  assert.equal(f.tasks.tasks().length, 0);
});

test("pending requests survive schema migration and never appear as personal memory or another owner's context", async () => {
  mkdirSync(path.resolve(".test-tmp"), { recursive: true });
  const root = mkdtempSync(path.resolve(".test-tmp/routing-migration-"));
  const file = path.join(root, "bridge.sqlite");
  let store = new Store(file);
  store.setSetting("boundUser", "owner");
  store.put<RoutingRequest>("routing_requests", {
    id: "pending",
    userId: "owner",
    original,
    messages: [{ id: "pending", text: original }],
    threadName: "1",
    state: "awaiting_target",
    lastReply: "这是哪个项目里的对话？",
    updatedAt: Date.now(),
  });
  store.close();
  store = new Store(file);
  assert.equal(
    store.all<RoutingRequest>("routing_requests")[0]!.original,
    original,
  );
  assert.equal(store.all("user_memories").length, 0);
  store.setSetting("boundUser", "new-owner");
  assert.deepEqual(store.all("routing_requests"), []);
  store.close();
});

test("version 4 migration adds routing state without changing a running task", () => {
  mkdirSync(path.resolve(".test-tmp"), { recursive: true });
  const file = path.join(
    mkdtempSync(path.resolve(".test-tmp/routing-v4-")),
    "bridge.sqlite",
  );
  let store = new Store(file);
  store.setSetting("boundUser", "owner");
  store.put("tasks", {
    id: "running-literature",
    status: "RUNNING",
    threadId: "keep-thread",
    title: "已有工作",
  });
  store.db.exec(
    "DROP TABLE routing_requests; DELETE FROM schema_migrations WHERE version=5",
  );
  const before = store.get("tasks", "running-literature");
  store.close();
  store = new Store(file);
  assert.deepEqual(store.get("tasks", "running-literature"), before);
  assert.deepEqual(store.all("routing_requests"), []);
  assert.equal(
    store.db.prepare("SELECT MAX(version) n FROM schema_migrations").get()?.n,
    6,
  );
  store.close();
});
