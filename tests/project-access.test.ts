import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executionProject } from "../src/computer/projects.js";
import { WorkspaceCatalog } from "../src/computer/workspaces.js";
import { loadConfig } from "../src/app/config.js";
import { Store } from "../src/storage/store.js";
import { MockCodex } from "../src/codex/mock.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import { TaskOrchestrator } from "../src/tasks/orchestrator.js";

interface OfficialProject {
  id: string;
  name: string;
  roots: { path: string }[];
  metadata: Record<string, string>;
  position: number;
  createdAt: number;
  updatedAt: number;
}
function fixture(t: TestContext) {
  const base = realpathSync.native(tmpdir());
  const root = mkdtempSync(path.join(base, "bridge-project-access-"));
  const store = new Store(":memory:");
  t.after(() => {
    store.close();
    assert.equal(path.dirname(path.resolve(root)), base);
    assert.ok(path.basename(root).startsWith("bridge-project-access-"));
    rmSync(root, { recursive: true, force: true });
  });
  const directory = (relative: string) => {
    const result = path.join(root, relative);
    mkdirSync(result, { recursive: true });
    return realpathSync.native(result);
  };
  const config = loadConfig("nonexistent-project-access-config.json");
  config.dataDir = directory("bridge-data");
  const codex = new MockCodex();
  codex.connected = true;
  const official: OfficialProject[] = [];
  const requests: string[] = [];
  const original = codex.request.bind(codex);
  codex.request = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    requests.push(method);
    return method === "project/list"
      ? ({ data: official, nextCursor: null } as T)
      : original<T>(method, params);
  };
  const notices = new NotificationManager(store, new MockWeChat());
  const tasks = new TaskOrchestrator(store, codex, notices, config);
  const catalog = new WorkspaceCatalog(codex, config, () => tasks.projects());
  store.setSetting("boundUser", "owner");
  const add = (id: string, name: string, ...roots: string[]) => {
    const project: OfficialProject = {
      id,
      name,
      roots: roots.map((relative) => ({ path: directory(relative) })),
      metadata: {},
      position: official.length,
      createdAt: 100,
      updatedAt: 200,
    };
    official.push(project);
    return project;
  };
  return { store, tasks, catalog, codex, official, requests, directory, add };
}

test("a bound user resolves an official project ID without manual project authorization", async (t) => {
  const f = fixture(t);
  const formal = f.add("official-report", "工作检索", "吉林报告");
  assert.equal(f.tasks.projects().length, 0);
  const project = await executionProject(f.tasks, f.catalog, formal.id);
  assert.equal(project.path, formal.roots[0]!.path);
  assert.equal(
    project.name,
    "工作检索",
    "the official display name takes precedence over the folder basename",
  );
  assert.equal(f.tasks.projects().length, 1);
  assert.equal(f.store.all("approvals").length, 0);
  assert.equal(
    f.store.all("notification_deliveries").length,
    0,
    "resolving a known project must not ask for a second local grant",
  );
  const task = f.tasks.create(project.id, "检查项目情况");
  assert.equal(task.projectId, project.id);
  assert.equal(task.status, "QUEUED");
});

test("concurrent and repeated project resolution reuse one internal project record", async (t) => {
  const f = fixture(t);
  const formal = f.add("official", "文献打包", "folder-name");
  const [first, second] = await Promise.all([
    executionProject(f.tasks, f.catalog, formal.id),
    executionProject(f.tasks, f.catalog, formal.id),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(
    (await executionProject(f.tasks, f.catalog, formal.id)).id,
    first.id,
  );
  assert.equal(
    (await executionProject(f.tasks, f.catalog, formal.name)).id,
    first.id,
  );
  assert.equal(f.tasks.projects().length, 1);
});

test("unknown IDs and arbitrary paths cannot become execution projects", async (t) => {
  const f = fixture(t);
  const formal = f.add("official", "真实项目", "real-project");
  const outside = f.directory("unlisted-but-existing");
  for (const candidate of [
    "invented-id",
    outside,
    formal.roots[0]!.path,
    "../real-project",
    "C:\\Windows",
  ]) {
    await assert.rejects(
      executionProject(f.tasks, f.catalog, candidate),
      /没有找到/,
    );
  }
  assert.equal(f.tasks.projects().length, 0);
  assert.equal(f.tasks.tasks().length, 0);
});

test("an unbound user cannot auto-create an execution project from official discovery", async (t) => {
  const f = fixture(t);
  const formal = f.add("official", "真实项目", "real-project");
  f.store.setSetting("boundUser", null);
  await assert.rejects(executionProject(f.tasks, f.catalog, formal.id), /绑定/);
  assert.equal(f.tasks.projects().length, 0);
  assert.equal(f.requests.length, 0);
});

test("an existing internal project record does not bypass the current WeChat binding", async (t) => {
  const f = fixture(t);
  const formal = f.add("official", "真实项目", "real-project");
  const project = await executionProject(f.tasks, f.catalog, formal.id);
  f.store.setSetting("boundUser", null);
  for (const target of [project.id, project.name, formal.id])
    await assert.rejects(executionProject(f.tasks, f.catalog, target), /绑定/);
  assert.equal(f.tasks.projects().length, 0);
  f.store.setSetting("boundUser", "owner");
  assert.equal(f.tasks.projects().length, 1);
  assert.equal(f.tasks.tasks().length, 0);
});

test("a multi-root official project needs a specific workspace while a selected workspace can execute", async (t) => {
  const f = fixture(t);
  const formal = f.add("multiple", "分析项目", "source-one", "source-two");
  await assert.rejects(
    executionProject(f.tasks, f.catalog, formal.id),
    /多个工作目录/,
  );
  assert.equal(f.tasks.projects().length, 0);
  const snapshot = f.catalog.snapshot();
  const selected = snapshot.workspaces.find(
    (workspace) => workspace.path === formal.roots[1]!.path,
  )!;
  const project = await executionProject(f.tasks, f.catalog, selected.id);
  assert.equal(project.path, formal.roots[1]!.path);
  assert.equal(project.name, "分析项目");
  assert.equal(f.tasks.projects().length, 1);
});

test("thread-discovered workspace IDs also resolve without a manual project record", async (t) => {
  const f = fixture(t);
  const directory = f.directory("thread-only-project");
  f.codex.threads.set("thread", { cwd: directory, updatedAt: 200 });
  const snapshot = await f.catalog.refresh();
  const workspace = snapshot.workspaces[0]!;
  const project = await executionProject(f.tasks, f.catalog, workspace.id);
  assert.equal(project.path, directory);
  assert.equal(project.name, "thread-only-project");
  assert.equal(
    (await executionProject(f.tasks, f.catalog, workspace.id)).id,
    project.id,
  );
  assert.equal(f.tasks.projects().length, 1);
});

test("a formal project with no readable root cannot become a fabricated local execution target", async (t) => {
  const f = fixture(t);
  const formal = f.add(
    "private",
    "云端资料项目",
    "profile/.codex/private-project",
  );
  await assert.rejects(
    executionProject(f.tasks, f.catalog, formal.id),
    /当前可用的本地目录/,
  );
  assert.equal(f.catalog.snapshot().projects[0]?.name, formal.name);
  assert.equal(f.tasks.projects().length, 0);
});

test("same-named official projects are ambiguous until the official ID is selected", async (t) => {
  const f = fixture(t);
  const first = f.add("one", "分析", "one");
  f.add("two", "分析", "two");
  await assert.rejects(
    executionProject(f.tasks, f.catalog, "分析"),
    /多个同名项目/,
  );
  assert.equal(f.tasks.projects().length, 0);
  assert.equal(
    (await executionProject(f.tasks, f.catalog, first.id)).path,
    first.roots[0]!.path,
  );
});

test("unbinding while official discovery is in flight prevents auto-creating the execution project", async (t) => {
  const f = fixture(t);
  const formal = f.add("official", "真实项目", "real-project");
  const original = f.codex.request.bind(f.codex);
  let entered!: () => void;
  let release!: (result: unknown) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.codex.request = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    if (method !== "project/list") return original<T>(method, params);
    entered();
    return (await new Promise<unknown>((resolve) => {
      release = resolve;
    })) as T;
  };
  const resolving = executionProject(f.tasks, f.catalog, formal.id);
  await started;
  f.store.setSetting("boundUser", null);
  release({ data: f.official, nextCursor: null });
  await assert.rejects(resolving, /绑定/);
  assert.equal(f.tasks.projects().length, 0);
});
