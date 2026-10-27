import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexController } from "../src/app/types.js";
import {
  CodexVisibility,
  type VisibleProject,
} from "../src/codex/visibility.js";

function fixture(t: TestContext) {
  const parent = realpathSync.native(os.tmpdir());
  const directory = mkdtempSync(path.join(parent, "codex-wechat-visibility-"));
  const projectPath = path.join(directory, "project");
  const otherPath = path.join(directory, "other");
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  t.after(() => {
    const resolved = realpathSync.native(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("codex-wechat-visibility-"));
    rmSync(resolved, { recursive: true, force: true });
  });
  const project: VisibleProject = {
    id: "internal-id",
    name: "用户原项目名",
    path: projectPath,
  };
  const official = (id: string, name = project.name, root = projectPath) => ({
    id,
    name,
    roots: [{ path: root }],
  });
  return { project, projectPath, otherPath, official };
}

function adapter(
  handler: (
    method: string,
    params: Record<string, any>,
  ) => unknown | Promise<unknown>,
) {
  const calls: { method: string; params: Record<string, any> }[] = [];
  const codex = {
    request: async (method: string, params: Record<string, any> = {}) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  } as Pick<CodexController, "request">;
  return { calls, visibility: new CodexVisibility(codex) };
}

test("visibility reuses a canonical root on later pages without creating or renaming projects", async (t) => {
  const { project, otherPath, official } = fixture(t);
  const { visibility, calls } = adapter((method, params) => {
    assert.equal(method, "project/list");
    return params.cursor
      ? { data: [official("actual", "保留桌面项目名")], nextCursor: null }
      : {
          data: [official("other", "其他项目", otherPath)],
          nextCursor: "page-2",
        };
  });
  const input = { ...project, path: path.join(project.path, ".") + path.sep };
  if (process.platform === "win32") input.path = input.path.toUpperCase();
  assert.equal(await visibility.ensureProject(input), "actual");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["project/list", "project/list"],
  );
  assert.equal(calls[1]!.params.cursor, "page-2");
});

test("visibility prefers explicit IDs then exact names when multiple projects share a root", async (t) => {
  const { project, official } = fixture(t);
  const projects = [official("first", "另一个名字"), official("matching")];
  const { visibility, calls } = adapter((method) => {
    assert.equal(method, "project/list");
    return { data: projects };
  });
  assert.equal(
    await visibility.ensureProject({ ...project, codexProjectId: "first" }),
    "first",
  );
  assert.equal(await visibility.ensureProject(project), "matching");
  await assert.rejects(
    () => visibility.ensureProject({ ...project, name: "无法区分" }),
    /多个/,
  );
  assert.equal(
    calls.filter((call) => call.method === "project/create").length,
    0,
  );
});

test("visibility refuses duplicate matching names and explicit mismatched or stale IDs", async (t) => {
  const { project, otherPath, official } = fixture(t);
  const { visibility, calls } = adapter(() => ({
    data: [
      official("one"),
      official("two"),
      official("elsewhere", "别处", otherPath),
    ],
  }));
  await assert.rejects(() => visibility.ensureProject(project), /多个/);
  await assert.rejects(
    () => visibility.ensureProject({ ...project, codexProjectId: "elsewhere" }),
    /不匹配/,
  );
  await assert.rejects(
    () => visibility.ensureProject({ ...project, codexProjectId: "missing" }),
    /不存在/,
  );
  assert.ok(calls.every((call) => call.method === "project/list"));
});

test("visibility creates only an absent project once, retaining the name and using a path-stable key", async (t) => {
  const { project, projectPath, official } = fixture(t);
  let created = false;
  let firstKey = "";
  const { visibility, calls } = adapter((method, params) => {
    if (method === "project/list")
      return { data: created ? [official("created")] : [] };
    assert.equal(method, "project/create");
    created = true;
    firstKey = params.idempotencyKey;
    assert.equal(params.name, project.name);
    assert.deepEqual(params.roots, [
      { path: realpathSync.native(projectPath) },
    ]);
    return { project: official("created") };
  });
  assert.deepEqual(
    await Promise.all([
      visibility.ensureProject(project),
      visibility.ensureProject(project),
    ]),
    ["created", "created"],
  );
  assert.equal(await visibility.ensureProject(project), "created");
  assert.equal(
    calls.filter((call) => call.method === "project/create").length,
    1,
  );
  assert.match(firstKey, /^codex-wechat-project-[a-f0-9]{64}$/);
  const retry = adapter((method, params) => {
    if (method === "project/list") return { data: [] };
    assert.equal(method, "project/create");
    assert.equal(params.idempotencyKey, firstKey);
    return { project: official("created") };
  });
  assert.equal(
    await retry.visibility.ensureProject({
      ...project,
      id: "different-internal-id",
      path: project.path + path.sep,
    }),
    "created",
  );
});

test("visibility never treats list errors or incomplete pagination as project absence", async (t) => {
  const { project } = fixture(t);
  const handlers = [
    () => {
      throw new Error("project API offline");
    },
    () => ({ data: "malformed" }),
    () => ({ data: [{ id: "broken", name: "项目", roots: "wrong" }] }),
    () => ({ data: [], nextCursor: "repeated" }),
    () => ({ data: [], nextCursor: 12 }),
    (_method: string, params: Record<string, any>) => {
      if (params.cursor) throw new Error("second page failed");
      return { data: [], nextCursor: "second" };
    },
  ];
  for (const handler of handlers) {
    const { visibility, calls } = adapter(handler);
    await assert.rejects(() => visibility.ensureProject(project));
    assert.ok(calls.every((call) => call.method === "project/list"));
  }
});

test("visibility propagates create failures and preserves the idempotency key for a retry", async (t) => {
  const { project, official } = fixture(t);
  const keys: string[] = [];
  const { visibility } = adapter((method, params) => {
    if (method === "project/list") return { data: [] };
    keys.push(params.idempotencyKey);
    if (keys.length === 1) throw new Error("create response uncertain");
    return { project: official("created") };
  });
  await assert.rejects(() => visibility.ensureProject(project), /uncertain/);
  assert.equal(await visibility.ensureProject(project), "created");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("visibility validates create results instead of attaching an unrelated project", async (t) => {
  const { project, otherPath, official } = fixture(t);
  for (const result of [
    {},
    { project: official("wrong", "别处", otherPath) },
  ]) {
    const { visibility } = adapter((method) =>
      method === "project/list" ? { data: [] } : result,
    );
    await assert.rejects(
      () => visibility.ensureProject(project),
      /无效|不匹配/,
    );
  }
});

test("visibility attaches and names threads using metadata APIs only, without model execution", async () => {
  const { visibility, calls } = adapter(() => ({}));
  await visibility.attachThread("thread-1", "official-project");
  await visibility.setName("thread-1", "微信：检查模型");
  assert.deepEqual(calls, [
    {
      method: "thread/metadata/update",
      params: { threadId: "thread-1", projectId: "official-project" },
    },
    {
      method: "thread/name/set",
      params: { threadId: "thread-1", name: "微信：检查模型" },
    },
  ]);
  await assert.rejects(() => visibility.attachThread("thread-1", ""), /ID/);
  await assert.rejects(() => visibility.setName("thread-1", " "), /名称/);
  assert.equal(calls.length, 2);
});
