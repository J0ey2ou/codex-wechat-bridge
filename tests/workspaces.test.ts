import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceCatalog } from "../src/computer/workspaces.js";
import { MockCodex } from "../src/codex/mock.js";
import { loadConfig } from "../src/app/config.js";
import type { Project } from "../src/app/types.js";

function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-workspaces-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("bridge-workspaces-"));
    rmSync(root, { recursive: true, force: true });
  });
  const make = (name: string) => {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    return realpathSync.native(directory);
  };
  const config = loadConfig("nonexistent-workspace-config.json");
  config.dataDir = make("bridge-data");
  const codex = new MockCodex();
  codex.connected = true;
  const request = codex.request.bind(codex);
  codex.request = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> =>
    method === "project/list"
      ? ({ data: [], nextCursor: null } as T)
      : request<T>(method, params);
  const projects: Project[] = [];
  const catalog = new WorkspaceCatalog(codex, config, () => projects);
  return { root, make, config, codex, projects, catalog };
}

test("workspace discovery spans providers and pages, deduplicates directories and merges registered projects", async (t) => {
  const f = setup(t);
  const first = f.make("one/app"),
    second = f.make("two/app"),
    registered = f.make("registered");
  const qa = f.make("bridge-data/qa-workspace");
  f.projects.push({
    id: "manual",
    name: "本机项目",
    path: registered,
    createdAt: 1,
  });
  const calls: Record<string, unknown>[] = [];
  f.codex.request = async <T>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    if (method === "project/list") return { data: [], nextCursor: null } as T;
    assert.equal(method, "thread/list");
    calls.push(params);
    return (
      params.cursor
        ? {
            data: [
              { cwd: first, updatedAt: 20 },
              { cwd: second, updatedAt: 15 },
              { cwd: registered, updatedAt: 12 },
            ],
            nextCursor: null,
          }
        : {
            data: [
              { cwd: first, updatedAt: 10 },
              { cwd: qa },
              { cwd: f.config.dataDir },
              { cwd: path.join(f.root, "deleted") },
              { cwd: "relative/path" },
              { cwd: path.parse(f.root).root },
            ],
            nextCursor: "second",
          }
    ) as T;
  };
  const snapshot = await f.catalog.refresh();
  assert.equal(snapshot.workspaces.length, 3);
  assert.deepEqual(
    calls.map((call) => call.modelProviders),
    [[], []],
  );
  assert.ok(calls.every((call) => !("cwd" in call)));
  assert.equal(calls[1]?.cursor, "second");
  assert.equal(snapshot.workspaces[0]?.lastActive, 20_000);
  assert.equal(
    snapshot.workspaces.find((w) => w.path === registered)?.source,
    "registered+codex",
  );
  assert.equal(
    snapshot.workspaces.find((w) => w.path === registered)?.name,
    "本机项目",
  );
  const output = await f.catalog.list();
  assert.ok(output.includes("app（one）") && output.includes("app（two）"));
  assert.ok(output.includes("本机项目"));
  assert.ok(!output.includes(first) && !output.includes(second));
  assert.ok(!/授权|已接入|Bridge|Codex 最近使用/.test(output));
  assert.equal(calls.length, 2, "list reuses the discovery cache");
});

test("workspace IDs stay stable across registration and repeated discovery", async (t) => {
  const f = setup(t);
  const directory = f.make("project");
  f.codex.threads.set("first", { cwd: directory, updatedAt: 10 });
  const first = (await f.catalog.refresh()).workspaces[0]!;
  f.projects.push({
    id: "registered",
    name: "重命名项目",
    path: directory,
    createdAt: 2,
  });
  f.codex.threads.clear();
  f.codex.threads.set("different-thread", { cwd: directory, updatedAt: 20 });
  const second = (await f.catalog.refresh(true)).workspaces[0]!;
  assert.equal(second.id, first.id);
  assert.equal(second.name, "重命名项目");
  assert.equal(second.registered, true);
  assert.equal(second.lastActive, 20_000);
});

test("discovery failure retains the previous inventory and says data is stale, rather than no projects", async (t) => {
  const f = setup(t);
  const directory = f.make("project");
  f.codex.threads.set("known", { cwd: directory });
  const first = await f.catalog.refresh();
  let failedCalls = 0;
  f.codex.request = async () => {
    failedCalls++;
    throw new Error("连接暂时中断");
  };
  const failed = await f.catalog.refresh(true);
  assert.equal(failed.workspaces[0]?.id, first.workspaces[0]?.id);
  assert.equal(failed.updatedAt, first.updatedAt);
  assert.equal(failed.error, "连接暂时中断");
  const output = await f.catalog.list();
  assert.ok(output.includes("project"));
  assert.ok(!output.includes(directory));
  assert.ok(output.includes("未能更新"));
  assert.equal(
    failedCalls,
    2,
    "both failed discovery APIs are cached for 60 seconds too",
  );
});

test("initial discovery failure and no configured projects does not claim there are no projects", async (t) => {
  const f = setup(t);
  f.codex.connected = false;
  const output = await f.catalog.list();
  assert.ok(output.includes("无法确认有哪些项目"));
  assert.ok(!output.includes("还没有接入项目"));
});

test("concurrent refresh shares one API request and registered-only projects remain discoverable", async (t) => {
  const f = setup(t);
  const directory = f.make("registered");
  f.projects.push({
    id: "registered",
    name: "已授权",
    path: directory,
    createdAt: 1,
  });
  let release!: (value: any) => void;
  let calls = 0;
  f.codex.request = async <T>(method: string) => {
    if (method === "project/list") return { data: [], nextCursor: null } as T;
    calls++;
    return (await new Promise((resolve) => {
      release = resolve;
    })) as T;
  };
  const first = f.catalog.refresh();
  const second = f.catalog.refresh(true);
  release({ data: [], nextCursor: null });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.workspaces[0]?.source, "registered");
});

test("inspection returns one level of metadata and rejects traversal, absolute paths and unknown IDs", async (t) => {
  const f = setup(t);
  const directory = f.make("project"),
    child = f.make("project/child");
  writeFileSync(
    path.join(directory, "notes.txt"),
    "private body is never returned",
  );
  writeFileSync(path.join(child, "nested.txt"), "nested body");
  f.codex.threads.set("project", { cwd: directory });
  const workspace = (await f.catalog.refresh()).workspaces[0]!;
  const result = f.catalog.inspect(workspace.id);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["child", "notes.txt"],
  );
  assert.equal(
    result.entries.find((entry) => entry.name === "notes.txt")?.type,
    "file",
  );
  assert.equal(
    result.entries.find((entry) => entry.name === "notes.txt")?.size,
    30,
  );
  assert.ok(!JSON.stringify(result).includes("private body"));
  assert.equal(
    f.catalog.inspect(workspace.id, "child").entries[0]?.name,
    "nested.txt",
  );
  assert.throws(
    () => f.catalog.inspect(workspace.id, "../bridge-data"),
    /之外/,
  );
  assert.throws(() => f.catalog.inspect(workspace.id, directory), /相对路径/);
  assert.throws(() => f.catalog.inspect("invented"), /没有找到/);
  assert.throws(() => f.catalog.inspect(workspace.id, "notes.txt"), /不是目录/);
});

test("inspection does not follow an escaping directory junction or enter Bridge data", async (t) => {
  const f = setup(t);
  const directory = f.make("project"),
    outside = f.make("outside");
  const data = f.make("project/data");
  f.config.dataDir = data;
  symlinkSync(
    outside,
    path.join(directory, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  f.codex.threads.set("project", { cwd: directory });
  f.codex.threads.set("private-data", { cwd: data });
  const snapshot = await f.catalog.refresh();
  assert.equal(snapshot.workspaces.length, 1);
  const workspace = snapshot.workspaces[0]!;
  const result = f.catalog.inspect(workspace.id);
  assert.equal(
    result.entries.find((entry) => entry.name === "escape")?.accessible,
    false,
  );
  assert.equal(
    result.entries.find((entry) => entry.name === "escape")?.type,
    "symlink",
  );
  assert.equal(
    result.entries.find((entry) => entry.name === "data")?.accessible,
    false,
  );
  assert.throws(() => f.catalog.inspect(workspace.id, "escape"), /之外/);
  assert.throws(
    () => f.catalog.inspect(workspace.id, "data"),
    /Bridge 数据目录/,
  );
});

test("failed pagination retains complete prior discovery instead of publishing a partial inventory", async (t) => {
  const f = setup(t);
  const directory = f.make("known"),
    partial = f.make("partial");
  f.codex.threads.set("known", { cwd: directory });
  await f.catalog.refresh();
  f.codex.request = async <T>(method: string) =>
    (method === "project/list"
      ? { data: [], nextCursor: null }
      : { data: [{ cwd: partial }], nextCursor: "repeated" }) as T;
  const snapshot = await f.catalog.refresh(true);
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(snapshot.workspaces[0]?.path, directory);
  assert.match(snapshot.error ?? "", /分页/);
});

test("discovery excludes historical QA workspaces from other Bridge instances but keeps ordinary data directories", async (t) => {
  const f = setup(t);
  const historical = f.make("another-bridge/data/qa-workspace");
  const ordinary = f.make("normal-project/data");
  const nestedPrivate = f.make("bridge-data/nested/project");
  f.codex.threads.set("old-qa", { cwd: historical });
  f.codex.threads.set("ordinary", { cwd: ordinary });
  f.codex.threads.set("private", { cwd: nestedPrivate });
  assert.deepEqual(
    (await f.catalog.refresh()).workspaces.map((w) => w.path),
    [ordinary],
  );
});

test("workspace list displays at most 25 entries with an explicit remaining count", async (t) => {
  const f = setup(t);
  for (let n = 0; n < 31; n++)
    f.codex.threads.set(String(n), {
      cwd: f.make(`p${String(n).padStart(2, "0")}`),
    });
  const output = await f.catalog.list();
  assert.equal((output.match(/^\d+\./gm) ?? []).length, 25);
  assert.ok(output.includes("另有 6 个项目未展示"));
  assert.ok(output.length <= 3500);
});

test("workspace list shows names without revealing long paths and reports omitted projects", async (t) => {
  const f = setup(t);
  const padding = "long-path-".repeat(8);
  for (let n = 0; n < 30; n++)
    f.codex.threads.set(String(n), {
      cwd: f.make(`${padding}/p${String(n).padStart(2, "0")}`),
    });
  const output = await f.catalog.list();
  const displayed = (output.match(/^\d+\./gm) ?? []).length;
  assert.equal(displayed, 25);
  assert.ok(output.includes(`另有 ${30 - displayed} 个项目未展示`));
  assert.ok(output.length <= 3500);
  assert.ok(!output.includes(f.catalog.snapshot().workspaces[0]!.path));
  assert.ok(!output.includes(padding));
});

test("official project names and roots are authoritative, paginated, and include projects without chat history", async (t) => {
  const f = setup(t);
  const report = f.make("吉林报告"),
    literature = f.make("文献打包自动化"),
    extra = f.make("unlisted");
  f.projects.push({
    id: "manual",
    name: "旧的手工名称",
    path: report,
    createdAt: 1,
  });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  f.codex.request = async <T>(
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    calls.push({ method, params });
    if (method === "project/list")
      return (
        params.cursor
          ? {
              data: [
                {
                  id: "literature",
                  name: "文献打包",
                  roots: [{ path: literature }],
                },
              ],
              nextCursor: null,
            }
          : {
              data: [
                {
                  id: "report",
                  name: "工作检索",
                  roots: [{ path: report }],
                  recencyAt: 200,
                },
              ],
              nextCursor: "projects-next",
            }
      ) as T;
    return { data: [{ cwd: report }, { cwd: extra }], nextCursor: null } as T;
  };
  const snapshot = await f.catalog.refresh();
  assert.equal(
    calls.filter((call) => call.method === "project/list").length,
    2,
  );
  assert.equal(
    calls.find((call) => call.params.cursor)?.params.cursor,
    "projects-next",
  );
  assert.equal(
    snapshot.workspaces.find((w) => w.path === report)?.name,
    "工作检索",
  );
  assert.equal(
    snapshot.workspaces.find((w) => w.path === literature)?.name,
    "文献打包",
  );
  assert.deepEqual(
    snapshot.projects.map((p) => p.name),
    ["工作检索", "文献打包", "unlisted"],
  );
  assert.equal(
    snapshot.projects.find((p) => p.id === "report")?.lastActive,
    200_000,
  );
  assert.equal(
    snapshot.projects.find((p) => p.name === "unlisted")?.source,
    "workspace",
  );
  const output = await f.catalog.list();
  assert.ok(output.includes("工作检索") && output.includes("文献打包"));
  assert.ok(!output.includes("旧的手工名称") && !output.includes(report));
});

test("multi-root projects appear once while different projects sharing a root retain their own names", async (t) => {
  const f = setup(t);
  const first = f.make("a/tmb"),
    second = f.make("b/tmb");
  f.codex.request = async <T>(method: string) =>
    (method === "project/list"
      ? {
          data: [
            {
              id: "combined",
              name: "tmb",
              roots: [{ path: first }, { path: second }],
            },
            { id: "mortality", name: "死因建模", roots: [{ path: second }] },
          ],
          nextCursor: null,
        }
      : { data: [], nextCursor: null }) as T;
  const snapshot = await f.catalog.refresh();
  assert.equal(snapshot.workspaces.length, 2);
  assert.equal(snapshot.projects.length, 2);
  assert.equal(
    snapshot.projects.find((p) => p.id === "combined")?.workspaceIds.length,
    2,
  );
  assert.deepEqual(
    snapshot.workspaces.find((w) => w.path === second)?.projectIds,
    ["combined", "mortality"],
  );
  assert.deepEqual(
    snapshot.workspaces.find((w) => w.path === second)?.projectNames,
    ["tmb", "死因建模"],
  );
  const output = await f.catalog.list();
  assert.equal((output.match(/tmb/g) ?? []).length, 1);
  assert.ok(output.includes("死因建模"));
});

test("official projects with private or unavailable roots keep their names without granting read roots", async (t) => {
  const f = setup(t);
  const privateRoot = f.make("profile/.codex/.chatgpt-projects/imported");
  f.codex.request = async <T>(method: string) =>
    (method === "project/list"
      ? {
          data: [
            {
              id: "private",
              name: "论文 可避免住院",
              roots: [{ path: privateRoot }],
            },
            {
              id: "offline",
              name: "离线资料",
              roots: [{ path: path.join(f.root, "missing") }],
            },
          ],
          nextCursor: null,
        }
      : { data: [{ cwd: privateRoot }], nextCursor: null }) as T;
  const snapshot = await f.catalog.refresh();
  assert.deepEqual(snapshot.workspaces, []);
  assert.deepEqual(
    snapshot.projects.map((p) => p.workspaceIds),
    [[], []],
  );
  const output = await f.catalog.list();
  assert.ok(output.includes("论文 可避免住院") && output.includes("离线资料"));
  assert.ok(!/授权|路径|\.codex/.test(output));
});

test("imported conversation folders and Bridge smoke directories never become thread-derived projects", async (t) => {
  const f = setup(t);
  const candidates = [
    "referenced-chatgpt-conversation-123",
    "reference/referenced-chatgpt-conversation-456/child",
    "other-bridge/test-output/chat-smoke",
    "other-bridge/test-output/computer-smoke/child",
    "old-bridge/qa-workspace/child",
    "real-project",
  ].map((name) => f.make(name));
  for (const [index, cwd] of candidates.entries())
    f.codex.threads.set(String(index), { cwd });
  const snapshot = await f.catalog.refresh();
  assert.deepEqual(
    snapshot.projects.map((p) => p.name),
    ["real-project"],
  );
});

test("same-named projects use the nearest distinguishing ancestor name, never a complete path", async (t) => {
  const f = setup(t);
  const one = f.make("team-one/common/app"),
    two = f.make("team-two/common/app");
  f.codex.request = async <T>(method: string) =>
    (method === "project/list"
      ? {
          data: [
            { id: "one", name: "分析", roots: [{ path: one }] },
            { id: "two", name: "分析", roots: [{ path: two }] },
          ],
          nextCursor: null,
        }
      : { data: [], nextCursor: null }) as T;
  const output = await f.catalog.list();
  assert.ok(
    output.includes("分析（team-one）") && output.includes("分析（team-two）"),
  );
  assert.ok(
    !output.includes(one) &&
      !output.includes(two) &&
      !output.includes("common"),
  );
});

test("failed official project refresh preserves names while successful thread refresh adds new directories", async (t) => {
  const f = setup(t);
  const official = f.make("folder"),
    extra = f.make("new-folder");
  f.codex.request = async <T>(method: string) =>
    (method === "project/list"
      ? {
          data: [
            {
              id: "official",
              name: "真实项目名称",
              roots: [{ path: official }],
            },
          ],
          nextCursor: null,
        }
      : { data: [], nextCursor: null }) as T;
  await f.catalog.refresh();
  f.codex.request = async <T>(method: string) => {
    if (method === "project/list")
      throw new Error("project list temporarily unavailable");
    return { data: [{ cwd: extra }], nextCursor: null } as T;
  };
  const snapshot = await f.catalog.refresh(true);
  assert.deepEqual(
    snapshot.projects.map((p) => p.name),
    ["真实项目名称", "new-folder"],
  );
  assert.ok(snapshot.error);
  assert.ok((await f.catalog.list()).includes("真实项目名称"));
});
