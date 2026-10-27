import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.js";
import type { Project, Task } from "../src/app/types.js";
import {
  ProjectCreator,
  type NewProjectRequest,
} from "../src/projects/create.js";
import { WorkspaceCatalog } from "../src/computer/workspaces.js";
import { executionProject } from "../src/computer/projects.js";
import { requireModel } from "../src/codex/models.js";
import { INTENT_SCHEMA } from "../src/app/intent.js";
import { Store } from "../src/storage/store.js";

const request = (
  values: Partial<NewProjectRequest> = {},
): NewProjectRequest => ({
  name: "阅读助手",
  directory: null,
  initialTask: null,
  model: null,
  ...values,
});
async function setup(t: test.TestContext) {
  const f = await fixture();
  t.after(async () => {
    await f.questions.drained();
    await f.tasks.drained();
    f.store.close();
  });
  mkdirSync(path.resolve(".test-tmp"), { recursive: true });
  f.config.projectCreationRoot = mkdtempSync(path.resolve(".test-tmp/create-"));
  f.config.codexMode = "mock";
  f.config.executionAuthorization = "bound-user";
  const official: any[] = [
    {
      id: "existing-official",
      name: f.project.name,
      roots: [{ path: f.project.path }],
    },
  ];
  const api = {
    models: ["gpt-6.1-sol"],
    createError: false,
    timeoutAfterCreate: false,
    badResponse: false,
    mismatch: false,
    listError: false,
    hook: undefined as undefined | ((method: string) => void),
  };
  const base = f.codex.request.bind(f.codex);
  f.codex.request = async (method, params = {}) => {
    const result = await base(method, params);
    api.hook?.(method);
    if (method === "model/list")
      return {
        data: api.models.map((model) => ({ id: model, model })),
        nextCursor: null,
      } as any;
    if (method === "project/list") {
      if (api.listError) throw new Error("unavailable");
      return { data: official, nextCursor: null } as any;
    }
    if (method === "project/create") {
      if (api.createError) throw new Error("unsupported project/create");
      const p = {
        id: `official-${official.length}`,
        name: params.name,
        roots: params.roots,
        metadata: params.metadata,
      };
      official.push(p);
      if (api.timeoutAfterCreate) throw new Error("response timeout");
      return {
        project: api.badResponse
          ? { ...p, roots: [{ path: process.cwd() }] }
          : p,
      } as any;
    }
    if (method === "thread/start" || method === "thread/resume")
      return {
        ...result,
        model: api.mismatch ? "other-model" : (params.model ?? "default-model"),
      };
    return result;
  };
  const creator = f.dispatcher.projectCreator;
  const createdCalls = () =>
    f.codex.calls.filter((c) => c.method === "project/create");
  return { ...f, creator, official, api, createdCalls };
}

test("WeChat decision creates official project, discovers immediately and executes initial and later tasks with the selected model", async (t) => {
  const f = await setup(t);
  const text = "新建 Codex 项目阅读助手，用 6.1sol，先整理需求";
  await f.router.receive({
    id: "create",
    userId: "owner",
    text,
    kind: "direct",
    sentAt: Date.now(),
  });
  const q = await f.decide("create", {
    action: "create_project",
    newProject: request({ model: "6.1sol", initialTask: "整理需求" }),
    reply: "不得使用这个编造的成功回复",
  });
  assert.equal(q.status, "completed");
  assert.match(q.answer!, /模拟.*未创建真实项目/);
  assert.match(q.answer!, /阅读助手.*official-1/s);
  assert.doesNotMatch(q.answer!, /编造/);
  const p = f.tasks.projects().find((p) => p.codexProjectId === "official-1")!;
  assert.ok(existsSync(p.path));
  assert.equal(p.executionModel, "gpt-6.1-sol");
  const catalog = new WorkspaceCatalog(f.codex, f.config, () =>
    f.tasks.projects(),
  );
  assert.equal(
    catalog.snapshot().projects.find((p) => p.id === "official-1")?.source,
    "codex",
  );
  assert.equal(
    (await executionProject(f.tasks, catalog, "official-1")).id,
    p.id,
  );
  assert.equal(f.tasks.tasks().length, 1);
  await f.tasks.pump();
  const first = f.tasks.tasks()[0]!;
  assert.equal(first.status, "RUNNING");
  const projectCalls = f.codex.calls.filter(
    (c) =>
      ["thread/start", "turn/start"].includes(c.method) &&
      c.params.cwd === p.path,
  );
  assert.equal(projectCalls.length, 2);
  assert.ok(projectCalls.every((c) => c.params.model === "gpt-6.1-sol"));
  assert.equal(projectCalls[0]!.params.projectId, "official-1");
  assert.equal(projectCalls[1]!.params.approvalPolicy, "never");
  assert.deepEqual(projectCalls[1]!.params.sandboxPolicy.writableRoots, [
    p.path,
  ]);
  f.codex.emit("turn/completed", {
    threadId: first.threadId,
    turn: { id: first.turnId, status: "completed" },
  });
  await f.tasks.drained();
  f.questions.enqueue("在阅读助手里继续实现", "owner", "followup");
  await f.decide("followup", {
    action: "run",
    projectId: "official-1",
    text: "继续实现",
  });
  await f.tasks.pump();
  const resume = f.codex.calls
    .filter((c) => c.method === "thread/resume" && c.params.cwd === p.path)
    .at(-1)!;
  assert.equal(resume.params.threadId, first.threadId);
  assert.equal(resume.params.model, "gpt-6.1-sol");
  assert.equal(f.createdCalls().length, 1);
});

test("missing name clarifies; explicit directory and model are optional", async (t) => {
  const f = await setup(t);
  assert.match(
    await f.creator.create(request({ name: null }), "owner", "missing"),
    /叫什么名字/,
  );
  assert.equal(f.createdCalls().length, 0);
  assert.equal(f.store.all("project_creations").length, 0);
  const result = await f.creator.create(
    request({ directory: "nested/fresh" }),
    "owner",
    "named",
  );
  assert.match(result, /official-1/);
  assert.ok(
    existsSync(path.join(f.creator.defaultRoot("owner"), "nested/fresh")),
  );
  assert.equal(f.tasks.tasks().length, 0);
});

test("duplicate official name and existing directory never overwrite or execute", async (t) => {
  const f = await setup(t);
  f.official.push({ id: "old", name: "阅读助手", roots: [] });
  assert.match(
    await f.creator.create(request(), "owner", "dup-name"),
    /已有.*未新建/,
  );
  const dir = path.join(f.creator.defaultRoot("owner"), "occupied");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "keep.txt"), "untouched");
  assert.match(
    await f.creator.create(
      request({ name: "新名称", directory: "occupied" }),
      "owner",
      "dup-dir",
    ),
    /目录已经存在/,
  );
  assert.equal(readFileSync(path.join(dir, "keep.txt"), "utf8"), "untouched");
  assert.equal(f.createdCalls().length, 0);
  assert.equal(f.tasks.tasks().length, 0);
});

test("replay and concurrent requests create exactly one project and initial task", async (t) => {
  const f = await setup(t);
  const input = request({ initialTask: "整理需求", model: "6.1sol" });
  const [a, b] = await Promise.all([
    f.creator.create(input, "owner", "same"),
    f.creator.create(input, "owner", "same"),
  ]);
  assert.equal(a, b);
  const restarted = new ProjectCreator(f.store, f.tasks, f.codex, f.config);
  assert.equal(await restarted.create(input, "owner", "same"), a);
  assert.equal(f.createdCalls().length, 1);
  assert.equal(f.tasks.tasks().length, 1);
  assert.match(
    await restarted.create(input, "owner", "different-message"),
    /已有/,
  );
});

test("unknown create result is reconciled by operation metadata after restart without repeating create or task", async (t) => {
  const f = await setup(t);
  f.api.timeoutAfterCreate = true;
  const input = request({ initialTask: "整理需求" });
  assert.match(
    await f.creator.create(input, "owner", "timeout"),
    /不能确认创建成功/,
  );
  assert.equal(f.tasks.tasks().length, 0);
  const restarted = new ProjectCreator(f.store, f.tasks, f.codex, f.config);
  assert.match(await restarted.create(input, "owner", "retry"), /official-1/);
  assert.equal(f.createdCalls().length, 1);
  assert.equal(f.tasks.tasks().length, 1);
});

test("creation failure or unmatched response never claims local directory is an official project", async (t) => {
  const f = await setup(t);
  f.api.createError = true;
  assert.match(
    await f.creator.create(request(), "owner", "fail"),
    /不能确认创建成功/,
  );
  assert.equal(f.tasks.projects().length, 1);
  assert.equal(f.tasks.tasks().length, 0);
  assert.match(
    await f.creator.create(request(), "owner", "retry-fail"),
    /仍未确认/,
  );
  assert.equal(f.createdCalls().length, 1);
  f.api.createError = false;
  f.api.badResponse = true;
  assert.match(
    await f.creator.create(request({ name: "另一个" }), "owner", "bad"),
    /不能确认创建成功/,
  );
  assert.equal(f.tasks.projects().length, 1);
});

test("catalog failure and unavailable model fail before creating directories", async (t) => {
  const f = await setup(t);
  f.api.listError = true;
  await assert.rejects(
    f.creator.create(request(), "owner", "list-error"),
    /unavailable/,
  );
  f.api.listError = false;
  f.api.models = ["gpt-6-sol"];
  await assert.rejects(
    f.creator.create(request({ model: "6.1sol" }), "owner", "no-model"),
    /未列出 gpt-6.1-sol/,
  );
  assert.equal(existsSync(f.creator.defaultRoot("owner")), false);
  assert.equal(f.createdCalls().length, 0);
});

test("model catalog pages use actual model identifier not label or advertised id", async () => {
  const calls: any[] = [];
  const codex = {
    request: async (_m: string, params: any) => {
      calls.push(params);
      return (
        params.cursor
          ? {
              data: [{ id: "picker-id", model: "gpt-6.1-sol" }],
              nextCursor: null,
            }
          : {
              data: [{ id: "gpt-6.1-sol", model: "gpt-6-sol" }],
              nextCursor: "page2",
            }
      ) as any;
    },
  };
  assert.equal(await requireModel(codex, "6.1sol"), "gpt-6.1-sol");
  assert.equal(calls.length, 2);
});

for (const failure of ["unavailable", "mismatch"] as const)
  test(`execution refuses model ${failure} without fallback or turn`, async (t) => {
    const f = await setup(t);
    await f.creator.create(
      request({ model: "6.1sol", initialTask: "整理需求" }),
      "owner",
      "selected",
    );
    if (failure === "unavailable") f.api.models = [];
    else f.api.mismatch = true;
    await f.tasks.pump();
    assert.equal(f.tasks.tasks()[0]!.status, "FAILED");
    assert.equal(
      f.codex.calls.filter((c) => c.method === "turn/start").length,
      0,
    );
  });

test("binding change during preflight stops creation and records remain owner isolated", async (t) => {
  const f = await setup(t);
  f.api.hook = (method) => {
    if (method === "model/list") f.store.setSetting("boundUser", "other");
  };
  await assert.rejects(
    f.creator.create(request({ model: "6.1sol" }), "owner", "rebind"),
    /绑定已改变/,
  );
  assert.equal(f.createdCalls().length, 0);
  f.api.hook = undefined;
  f.store.setSetting("boundUser", "owner");
  await f.creator.create(request(), "owner", "owner-only");
  const catalog = new WorkspaceCatalog(
    f.codex,
    f.config,
    () => f.tasks.projects(),
    () => f.store.setting("boundUser", ""),
  );
  await catalog.refresh();
  assert.ok(catalog.snapshot().projects.some((p) => p.name === "阅读助手"));
  f.store.setSetting("boundUser", "other");
  assert.equal(f.store.all("project_creations").length, 0);
  assert.equal(f.tasks.projects().length, 0);
  assert.notEqual(
    f.creator.defaultRoot("owner"),
    f.creator.defaultRoot("other"),
  );
  assert.ok(!catalog.snapshot().projects.some((p) => p.name === "阅读助手"));
  await assert.rejects(executionProject(f.tasks, catalog, "official-1"));
});

test("absolute escapes, traversal, reserved names and symlink parents are rejected", async (t) => {
  const f = await setup(t);
  for (const directory of [
    "../escape",
    process.cwd(),
    "CON",
    ".codex/new",
    "bad.",
    "x:stream",
  ])
    await assert.rejects(
      f.creator.create(request({ directory }), "owner", directory),
    );
  mkdirSync(f.creator.defaultRoot("owner"), { recursive: true });
  const link = path.join(f.creator.defaultRoot("owner"), "link");
  symlinkSync(
    process.cwd(),
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.creator.create(request({ directory: "link/new" }), "owner", "link"),
    /链接/,
  );
  assert.equal(f.createdCalls().length, 0);
});

test("strict schema carries creation arguments and rejects extra or missing fields", async (t) => {
  const f = await setup(t);
  assert.ok(INTENT_SCHEMA.required.includes("newProject"));
  const valid = {
    action: "create_project",
    reply: "",
    computer: null,
    projectId: null,
    taskId: null,
    todoId: null,
    approvalId: null,
    text: null,
    date: null,
    repeatMinutes: null,
    newProject: request(),
  };
  assert.equal(
    f.dispatcher.parse(JSON.stringify(valid)).action,
    "create_project",
  );
  assert.throws(
    () =>
      f.dispatcher.parse(
        JSON.stringify({
          ...valid,
          newProject: { ...request(), overwrite: true },
        }),
      ),
    /参数无效/,
  );
  assert.throws(
    () => f.dispatcher.parse(JSON.stringify({ ...valid, newProject: {} })),
    /参数无效/,
  );
});

test("creating another project leaves an existing running literature task untouched", async (t) => {
  const f = await setup(t);
  const existing = f.tasks.create(f.project.id, "文献打包");
  await f.tasks.pump();
  const before = f.store.get<Task>("tasks", existing.id)!;
  const projectBefore = f.store.get<Project>("projects", f.project.id)!;
  await f.creator.create(request({ model: "6.1sol" }), "owner", "new-project");
  assert.deepEqual(f.store.get("tasks", existing.id), before);
  assert.deepEqual(f.store.get("projects", f.project.id), projectBefore);
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/interrupt").length,
    0,
  );
});

test("reported model rerouting stops only the selected task and never claims selected-model success", async (t) => {
  const f = await setup(t);
  await f.creator.create(
    request({ model: "6.1sol", initialTask: "整理需求" }),
    "owner",
    "rerouted",
  );
  await f.tasks.pump();
  const task = f.tasks.tasks()[0]!;
  f.codex.emit("model/rerouted", {
    threadId: task.threadId,
    turnId: task.turnId,
    fromModel: "gpt-6.1-sol",
    toModel: "other-model",
  });
  await f.tasks.drained();
  await f.tasks.drained();
  const result = f.store.get<Task>("tasks", task.id)!;
  assert.equal(result.status, "FAILED");
  assert.match(result.error!, /不一致/);
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/interrupt").length,
    1,
  );
});

test("a model mismatch reported on completion fails rather than continuing stages", async (t) => {
  const f = await setup(t);
  await f.creator.create(
    request({ model: "6.1sol", initialTask: "整理需求" }),
    "owner",
    "completed-mismatch",
  );
  await f.tasks.pump();
  const task = f.tasks.tasks()[0]!;
  f.codex.emit("turn/completed", {
    threadId: task.threadId,
    turn: { id: task.turnId, status: "completed", model: "other-model" },
  });
  await f.tasks.drained();
  assert.equal(f.store.get<Task>("tasks", task.id)!.status, "FAILED");
});

test("version 3 databases migrate creation journal without altering existing running work", () => {
  mkdirSync(path.resolve(".test-tmp"), { recursive: true });
  const file = path.join(
    mkdtempSync(path.resolve(".test-tmp/migration-")),
    "db.sqlite",
  );
  let store = new Store(file);
  store.setSetting("boundUser", "owner");
  store.put("tasks", {
    id: "literature",
    status: "WAITING_PROCESS",
    threadId: "existing-thread",
  });
  const before = store.get("tasks", "literature");
  store.db.exec(
    "DROP TABLE project_creations; DELETE FROM schema_migrations WHERE version=4",
  );
  store.close();
  store = new Store(file);
  assert.deepEqual(store.get("tasks", "literature"), before);
  assert.deepEqual(store.all("project_creations"), []);
  store.close();
});

test("missing-name question and follow-up preserve the genuine clarification context", async (t) => {
  const f = await setup(t);
  f.questions.enqueue("帮我新建一个项目，用 6.1sol", "owner", "clarify");
  const q = await f.decide("clarify", {
    action: "create_project",
    newProject: request({ name: null, model: "6.1sol" }),
  });
  assert.match(q.answer!, /叫什么名字/);
  assert.equal(f.createdCalls().length, 0);
  f.questions.enqueue("就叫阅读助手", "owner", "clarified");
  const q2 = await f.decide("clarified", {
    action: "create_project",
    newProject: request({ model: "6.1sol" }),
  });
  assert.match(q2.answer!, /official-1/);
  const input = f.codex.calls.filter((c) => c.method === "turn/start").at(-1)!
    .params.input[0].text;
  assert.match(input, /叫什么名字/);
});

test("binding changes during official creation cannot register or dispatch for the new user", async (t) => {
  const f = await setup(t);
  f.api.hook = (method) => {
    if (method === "project/create") f.store.setSetting("boundUser", "other");
  };
  const input = request({ initialTask: "整理需求" });
  await assert.rejects(
    f.creator.create(input, "owner", "inflight"),
    /绑定已改变/,
  );
  assert.equal(f.tasks.projects().length, 0);
  assert.equal(f.tasks.tasks().length, 0);
  f.store.setSetting("boundUser", "owner");
  f.api.hook = undefined;
  assert.match(
    await f.creator.create(input, "owner", "reconcile"),
    /official-1/,
  );
  assert.equal(f.createdCalls().length, 1);
  assert.equal(f.tasks.tasks().length, 1);
});

test("directory racing into existence is not adopted or removed", async (t) => {
  const f = await setup(t);
  const directory = path.join(f.creator.defaultRoot("owner"), "阅读助手");
  f.api.hook = (method) => {
    if (method === "model/list") {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "keep.txt"), "keep");
    }
  };
  assert.match(
    await f.creator.create(request({ model: "6.1sol" }), "owner", "race"),
    /目录未能安全创建/,
  );
  assert.equal(readFileSync(path.join(directory, "keep.txt"), "utf8"), "keep");
  assert.equal(f.createdCalls().length, 0);
});

test("unsupported official create method reports the limitation without a task or false success", async (t) => {
  const f = await setup(t);
  f.api.hook = (method) => {
    if (method === "project/create")
      throw new Error("Codex RPC -32601: Method not found");
  };
  assert.match(
    await f.creator.create(request(), "owner", "unsupported"),
    /不支持正式项目创建接口/,
  );
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.tasks.projects().length, 1);
});

test("two creator instances sharing the journal cannot overwrite a concurrent claim", async (t) => {
  const f = await setup(t);
  const other = new ProjectCreator(f.store, f.tasks, f.codex, f.config);
  await Promise.all([
    f.creator.create(request(), "owner", "shared"),
    other.create(request(), "owner", "shared"),
  ]);
  assert.equal(f.createdCalls().length, 1);
  assert.equal(f.store.all<any>("project_creations")[0]!.state, "complete");
});

test("uncertain name cannot be reused with a different directory or task", async (t) => {
  const f = await setup(t);
  f.api.createError = true;
  await f.creator.create(request(), "owner", "unknown");
  await assert.rejects(
    f.creator.create(request({ directory: "other" }), "owner", "changed"),
    /不同的创建请求/,
  );
  assert.equal(f.createdCalls().length, 1);
});

test("a created formal project cannot silently fall back to a local workspace when its official record is unavailable", async (t) => {
  const f = await setup(t);
  await f.creator.create(
    request({ initialTask: "整理需求" }),
    "owner",
    "formal-only",
  );
  f.api.listError = true;
  await f.tasks.pump();
  assert.equal(f.tasks.tasks()[0]!.status, "FAILED");
  assert.match(f.tasks.tasks()[0]!.error!, /正式 Codex 项目关联/);
  assert.equal(
    f.codex.calls.filter((c) => c.method === "turn/start").length,
    0,
  );
});
