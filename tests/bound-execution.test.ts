import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture } from "./helpers.js";
import { loadConfig, validateSettings } from "../src/app/config.js";
import type { Approval, Task } from "../src/app/types.js";

test("binding authorization is the default and execution modes are validated", () => {
  assert.equal(
    loadConfig("nonexistent-bound-config.json").executionAuthorization,
    "bound-user",
  );
  assert.doesNotThrow(() =>
    validateSettings({ executionAuthorization: "per-action" }),
  );
  assert.throws(
    () => validateSettings({ executionAuthorization: "invalid" as never }),
    /授权方式/,
  );
});

test("bound task execution uses project-write sandbox with no per-operation prompt", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  const task = f.tasks.create(f.project.id, "在这个项目内修改说明并运行测试");
  await f.tasks.pump();
  const thread = f.codex.calls.find(
    (call) => call.method === "thread/start",
  )!.params;
  const turn = f.codex.calls.find(
    (call) => call.method === "turn/start",
  )!.params;
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.sandbox, "workspace-write");
  assert.equal(thread.cwd, f.project.path);
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [f.project.path],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "RUNNING");
  assert.equal(f.store.all<Approval>("approvals").length, 0);
});

test("bound task stages continue in the same project session without inserted approvals", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  const task = f.tasks.create(f.project.id, "完成同一任务的两个阶段", [
    { title: "检查", prompt: "检查", requiresApproval: false, lowRisk: true },
    {
      title: "修改并测试",
      prompt: "修改并测试",
      requiresApproval: true,
      lowRisk: false,
    },
  ]);
  await f.tasks.pump();
  const first = f.store.get<Task>("tasks", task.id)!;
  f.codex.emit("turn/completed", {
    threadId: first.threadId,
    turn: { id: first.turnId, status: "completed" },
  });
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "QUEUED");
  assert.equal(f.store.all<Approval>("approvals").length, 0);
  await f.tasks.pump();
  const resumed = f.codex.calls.find(
    (call) => call.method === "thread/resume",
  )!.params;
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.sandbox, "workspace-write");
  assert.equal(resumed.approvalPolicy, "never");
  assert.equal(
    f.codex.calls.filter((call) => call.method === "turn/start").length,
    2,
  );
});

for (const method of [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]) {
  test(`bound execution denies ${method} and fails without asking for approval`, async () => {
    const f = await fixture();
    f.config.executionAuthorization = "bound-user";
    const task = f.tasks.create(f.project.id, "完成项目任务");
    await f.tasks.pump();
    const running = f.store.get<Task>("tasks", task.id)!;
    f.codex.emit("item/started", {
      threadId: running.threadId,
      turnId: running.turnId,
      item: {
        id: "blocked",
        type: "fileChange",
        changes: [
          {
            path: path.resolve(f.project.path, "..", "outside.txt"),
            kind: { type: "update" },
          },
        ],
      },
    });
    f.codex.emit(
      method,
      {
        threadId: running.threadId,
        turnId: running.turnId,
        itemId: "blocked",
        cwd: f.project.path,
        command: "write outside project",
        additionalPermissions: {
          fileSystem: { write: [path.dirname(f.project.path)] },
        },
      },
      73,
    );
    await f.tasks.drained();
    await f.tasks.drained();
    assert.equal(f.store.get<Task>("tasks", task.id)!.status, "FAILED");
    assert.match(f.store.get<Task>("tasks", task.id)!.error!, /额外权限/);
    assert.equal(f.store.all<Approval>("approvals").length, 0);
    assert.deepEqual(
      f.codex.responses[0]!.result,
      method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : { decision: "cancel" },
    );
    assert.ok(
      !f.store
        .all<{ text: string }>("notification_deliveries")
        .some((notice) => notice.text.includes("这一步需要你确认")),
    );
  });
}

test("bound execution keeps the initial identity boundary", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  await f.router.receive({
    id: "unbound-attempt",
    userId: "other-user",
    text: "/run 项目 | 修改文件",
    sentAt: Date.now(),
    kind: "direct",
  });
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.store.all("messages").length, 0);
});

test("switching to binding authorization releases only completed stage waits", async () => {
  const f = await fixture();
  const task = f.tasks.create(f.project.id, "已有阶段等待", [
    { title: "检查", prompt: "检查", requiresApproval: false, lowRisk: true },
    { title: "执行", prompt: "执行", requiresApproval: true, lowRisk: false },
  ]);
  await f.tasks.pump();
  const running = f.store.get<Task>("tasks", task.id)!;
  f.codex.emit("turn/completed", {
    threadId: running.threadId,
    turn: { id: running.turnId, status: "completed" },
  });
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "WAITING_APPROVAL");
  f.config.executionAuthorization = "bound-user";
  f.tasks.recover();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "QUEUED");
  assert.equal(f.store.all<Approval>("approvals")[0]!.status, "expired");
  await f.tasks.pump();
  f.tasks.recover();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "UNKNOWN");
});

test("an unconfirmed stop after a denied permission remains unknown and blocks the queue", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  const task = f.tasks.create(f.project.id, "受限任务");
  await f.tasks.pump();
  const running = f.store.get<Task>("tasks", task.id)!;
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params) => {
    if (method === "turn/interrupt") throw new Error("transport unavailable");
    return request(method, params);
  };
  f.codex.emit(
    "item/permissions/requestApproval",
    { threadId: running.threadId, turnId: running.turnId },
    91,
  );
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "UNKNOWN");
  assert.equal(f.store.all<Approval>("approvals").length, 0);
  f.tasks.create(f.project.id, "后续任务");
  await f.tasks.pump();
  assert.equal(
    f.codex.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
});

test("tasks created in the same millisecond execute by persistent enqueue order, not update order", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  const first = f.tasks.create(f.project.id, "先入队");
  const second = f.tasks.create(f.project.id, "后入队");
  assert.equal(second.queueOrder, first.queueOrder! + 1);
  assert.equal(f.store.setting("taskQueueOrder", 0), second.queueOrder);
  first.createdAt = second.createdAt = 1_700_000_000_000;
  f.store.put("tasks", first);
  f.store.put("tasks", second);
  // Force the database's updated-at ordering to return the second task first.
  f.store.db
    .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
    .run(101, first.id);
  f.store.db
    .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
    .run(102, second.id);
  assert.equal(f.store.all<Task>("tasks")[0]!.id, second.id);
  f.tasks.recover();
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", first.id)!.status, "RUNNING");
  assert.equal(f.store.get<Task>("tasks", second.id)!.status, "QUEUED");
  assert.equal(
    f.codex.calls.find((call) => call.method === "turn/start")!.params.input[0]
      .text,
    "先入队",
  );
});
