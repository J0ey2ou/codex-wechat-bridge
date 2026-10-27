import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { Project, Task } from "../src/app/types.js";
import type { Question } from "../src/codex/questions.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

function mockVisibility(
  f: Fixture,
  hook?: (method: string, params: Record<string, any>) => Promise<void> | void,
  projectIds = ["official-project"],
) {
  const request = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params = {}) => {
    const result = await request(method, params);
    if (hook) await hook(method, params);
    if (method === "project/list")
      return {
        data: projectIds.map((id) => ({
          id,
          name: f.project.name,
          roots: [{ path: f.project.path }],
        })),
        nextCursor: null,
      } as any;
    if (method === "project/create")
      throw new Error("Existing test projects must not be recreated");
    return result;
  };
}

function methods(f: Fixture, method: string) {
  return f.codex.calls.filter((call) => call.method === method);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function completeTask(f: Fixture, id: string) {
  const task = f.store.get<Task>("tasks", id)!;
  f.codex.emit("turn/completed", {
    threadId: task.threadId,
    turn: { id: task.turnId, status: "completed" },
  });
  await f.tasks.drained();
  await f.questions.drained();
}

test("new project task threads include the official project ID and are named before one model turn", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  mockVisibility(f);
  const task = f.tasks.create(f.project.id, "检查模型");
  await f.tasks.pump();
  const current = f.store.get<Task>("tasks", task.id)!;
  assert.equal(current.status, "RUNNING");
  assert.equal(methods(f, "thread/start").length, 1);
  assert.equal(
    methods(f, "thread/start")[0]!.params.projectId,
    "official-project",
  );
  assert.equal(
    methods(f, "thread/start")[0]!.params.sandbox,
    "workspace-write",
  );
  assert.equal(methods(f, "thread/start")[0]!.params.approvalPolicy, "never");
  assert.deepEqual(
    methods(f, "thread/name/set").map((call) => call.params),
    [
      {
        threadId: current.threadId,
        name: `微信 · ${f.project.name} · 检查模型`,
      },
    ],
  );
  assert.equal(methods(f, "turn/start").length, 1);
  assert.equal(methods(f, "turn/start")[0]!.params.threadId, current.threadId);
  assert.equal(methods(f, "thread/resume").length, 0);
  assert.equal(methods(f, "project/create").length, 0);
  assert.equal(
    f.store.get<Project>("projects", f.project.id)!.codexProjectId,
    "official-project",
  );
  assert.ok(
    f.codex.calls.findIndex((call) => call.method === "thread/name/set") <
      f.codex.calls.findIndex((call) => call.method === "turn/start"),
  );
});

test("saved project sessions are resumed and attached through metadata without a replacement thread", async () => {
  const f = await fixture();
  f.store.put<Project>("projects", {
    ...f.project,
    sessionId: "existing-thread",
    sessionOrigin: "desktop-fork",
    codexProjectId: "official-project",
  });
  mockVisibility(f);
  const task = f.tasks.create(f.project.id, "继续检查");
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "RUNNING");
  assert.equal(methods(f, "thread/start").length, 0);
  assert.equal(methods(f, "thread/resume").length, 1);
  assert.equal(
    methods(f, "thread/resume")[0]!.params.threadId,
    "existing-thread",
  );
  assert.deepEqual(
    methods(f, "thread/metadata/update").map((call) => call.params),
    [{ threadId: "existing-thread", projectId: "official-project" }],
  );
  assert.equal(
    methods(f, "thread/name/set").length,
    0,
    "existing conversation title is preserved",
  );
  assert.equal(methods(f, "turn/start").length, 1);
  assert.equal(methods(f, "turn/start")[0]!.params.threadId, "existing-thread");
});

test("new task title failures retain the thread and execute exactly once", async () => {
  const f = await fixture();
  mockVisibility(f, (method) => {
    if (method === "thread/name/set")
      throw new Error("title update unavailable");
  });
  const task = f.tasks.create(f.project.id, "检查代码");
  await f.tasks.pump();
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "RUNNING");
  assert.match(
    f.store.get<Project>("projects", f.project.id)!.visibilityError!,
    /title update unavailable/,
  );
  assert.equal(methods(f, "thread/start").length, 1);
  assert.equal(methods(f, "thread/name/set").length, 1);
  assert.equal(methods(f, "turn/start").length, 1);
  assert.equal(methods(f, "thread/resume").length, 0);
});

test("resume metadata failures preserve execution without another resume, thread or turn", async () => {
  const f = await fixture();
  f.store.put<Project>("projects", {
    ...f.project,
    sessionId: "existing-thread",
    codexProjectId: "official-project",
  });
  mockVisibility(f, (method) => {
    if (method === "thread/metadata/update")
      throw new Error("metadata update unavailable");
  });
  const task = f.tasks.create(f.project.id, "继续任务");
  await f.tasks.pump();
  await f.tasks.pump();
  const current = f.store.get<Task>("tasks", task.id)!;
  assert.equal(current.status, "RUNNING");
  assert.equal(current.threadId, "existing-thread");
  assert.match(
    f.store.get<Project>("projects", f.project.id)!.visibilityError!,
    /metadata update unavailable/,
  );
  assert.equal(methods(f, "thread/start").length, 0);
  assert.equal(methods(f, "thread/resume").length, 1);
  assert.equal(methods(f, "thread/metadata/update").length, 1);
  assert.equal(methods(f, "turn/start").length, 1);
});

test("queued tasks retain their official project selection when the internal project record changes", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  f.store.put<Project>("projects", {
    ...f.project,
    codexProjectId: "original-official",
  });
  mockVisibility(f, undefined, ["original-official", "other-official"]);
  const first = f.tasks.create(f.project.id, "第一件任务");
  const second = f.tasks.create(f.project.id, "第二件任务");
  assert.equal(
    f.store.get<Task>("tasks", first.id)!.codexProjectId,
    "original-official",
  );
  assert.equal(
    f.store.get<Task>("tasks", second.id)!.codexProjectId,
    "original-official",
  );
  f.store.put<Project>("projects", {
    ...f.project,
    codexProjectId: "other-official",
  });
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", second.id)!.status, "QUEUED");
  assert.equal(
    methods(f, "thread/start")[0]!.params.projectId,
    "original-official",
  );
  await completeTask(f, first.id);
  const updatedProject = f.store.get<Project>("projects", f.project.id)!;
  f.store.put<Project>("projects", {
    ...updatedProject,
    codexProjectId: "other-official",
  });
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", second.id)!.status, "RUNNING");
  assert.equal(
    f.store.get<Task>("tasks", second.id)!.codexProjectId,
    "original-official",
  );
  assert.equal(
    methods(f, "thread/metadata/update").at(-1)!.params.projectId,
    "original-official",
  );
  assert.equal(methods(f, "thread/start").length, 1);
  assert.equal(methods(f, "thread/resume").length, 1);
  assert.equal(methods(f, "turn/start").length, 2);
});

test("formal projects sharing one directory keep separate threads and return to their own session", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  mockVisibility(f, undefined, ["official-A", "official-B"]);
  const select = (id: string) =>
    f.store.put<Project>("projects", {
      ...f.store.get<Project>("projects", f.project.id)!,
      codexProjectId: id,
    });

  select("official-A");
  const firstA = f.tasks.create(f.project.id, "A 项目第一件任务");
  await f.tasks.pump();
  const threadA = f.store.get<Task>("tasks", firstA.id)!.threadId!;
  assert.equal(f.store.get<Task>("tasks", firstA.id)!.status, "RUNNING");
  await completeTask(f, firstA.id);

  select("official-B");
  const firstB = f.tasks.create(f.project.id, "B 项目第一件任务");
  await f.tasks.pump();
  const threadB = f.store.get<Task>("tasks", firstB.id)!.threadId!;
  assert.equal(f.store.get<Task>("tasks", firstB.id)!.status, "RUNNING");
  assert.notEqual(threadA, threadB);
  assert.equal(methods(f, "thread/resume").length, 0);
  assert.deepEqual(
    methods(f, "thread/start").map((call) => call.params.projectId),
    ["official-A", "official-B"],
  );
  assert.deepEqual(
    f.store.get<Project>("projects", f.project.id)!.sessionsByCodexProject,
    {
      "official-A": threadA,
      "official-B": threadB,
    },
  );
  assert.equal(
    f.store.get<Project>("projects", f.project.id)!.sessionCodexProjectId,
    "official-B",
  );
  await completeTask(f, firstB.id);

  select("official-A");
  const secondA = f.tasks.create(f.project.id, "回到 A 项目继续");
  await f.tasks.pump();
  const current = f.store.get<Task>("tasks", secondA.id)!;
  assert.equal(current.status, "RUNNING");
  assert.equal(current.threadId, threadA);
  assert.equal(current.codexProjectId, "official-A");
  assert.equal(methods(f, "thread/start").length, 2);
  assert.deepEqual(
    methods(f, "thread/resume").map((call) => call.params.threadId),
    [threadA],
  );
  assert.deepEqual(
    methods(f, "thread/metadata/update").map((call) => call.params),
    [{ threadId: threadA, projectId: "official-A" }],
  );
  assert.deepEqual(
    methods(f, "turn/start").map((call) => call.params.threadId),
    [threadA, threadB, threadA],
  );
  const stored = f.store.get<Project>("projects", f.project.id)!;
  assert.equal(stored.sessionId, threadA);
  assert.equal(stored.sessionCodexProjectId, "official-A");
  assert.deepEqual(stored.sessionsByCodexProject, {
    "official-A": threadA,
    "official-B": threadB,
  });
});

test("QA title errors do not drop the answer or duplicate model execution", async () => {
  const f = await fixture();
  mockVisibility(f, (method) => {
    if (method === "thread/name/set") throw new Error("QA title unavailable");
  });
  f.questions.enqueue("你好", "owner", "qa");
  const answer = await f.decide("qa", { reply: "你好，我在。" });
  assert.equal(answer.status, "completed");
  assert.equal(answer.answer, "你好，我在。");
  assert.match(
    f.store.setting("qa-visibility:owner", ""),
    /QA title unavailable/,
  );
  assert.equal(methods(f, "thread/start").length, 1);
  assert.equal(methods(f, "thread/name/set").length, 1);
  assert.equal(methods(f, "turn/start").length, 1);
});

test("QA failure during awaited naming cannot start a model turn afterward", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  mockVisibility(f, async (method) => {
    if (method === "thread/name/set") {
      entered.resolve();
      await release.promise;
    }
  });
  f.questions.enqueue("问个问题", "owner", "qa");
  const pumping = f.questions.pump();
  await entered.promise;
  assert.equal(f.store.get<Question>("questions", "qa")!.status, "running");
  f.questions.monitor(Date.now() + 91000);
  assert.equal(f.store.get<Question>("questions", "qa")!.status, "failed");
  release.resolve();
  await pumping;
  await f.questions.drained();
  assert.equal(f.store.get<Question>("questions", "qa")!.status, "failed");
  assert.equal(methods(f, "thread/start").length, 1);
  assert.equal(methods(f, "turn/start").length, 0);
  assert.equal(f.store.setting("qa-session:owner", null), null);
});

test("QA unbinding during awaited naming prevents a turn for the former owner", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  mockVisibility(f, async (method) => {
    if (method === "thread/name/set") {
      entered.resolve();
      await release.promise;
    }
  });
  f.questions.enqueue("问个问题", "owner", "qa");
  const pumping = f.questions.pump();
  await entered.promise;
  f.store.setSetting("boundUser", null);
  release.resolve();
  await pumping;
  await f.questions.drained();
  assert.equal(f.store.setting("boundUser", null), null);
  assert.equal(methods(f, "thread/start").length, 1);
  assert.equal(methods(f, "turn/start").length, 0);
  assert.equal(f.store.all("notification_deliveries").length, 0);
});
