import test from "node:test";
import assert from "node:assert/strict";
import { CodexActivityMonitor } from "../src/codex/activity.js";
import { WorkspaceCatalog } from "../src/computer/workspaces.js";
import { fixture } from "./helpers.js";
import type { Task } from "../src/app/types.js";
const now = Date.UTC(2026, 9, 27);
const sec = (t: number) => t / 1000;
const thread = (id: string, extra: any = {}) => ({
  id,
  name: id,
  cwd: process.cwd(),
  projectId: null,
  source: "vscode",
  updatedAt: sec(now),
  status: { type: "notLoaded" },
  ...extra,
});
async function setup() {
  const f = await fixture();
  const rows: any[] = [];
  const turns = new Map<string, any>();
  const calls: { method: string; params: any }[] = [];
  let fail = false;
  let before: ((method: string) => void | Promise<void>) | undefined;
  f.codex.request = async (method: string, params: any = {}) => {
    calls.push({ method, params });
    await before?.(method);
    if (fail) throw new Error("read failed");
    if (method === "thread/list") {
      const start = Number(params.cursor ?? 0),
        end = start + 50;
      return {
        data: rows.slice(start, end),
        nextCursor: end < rows.length ? String(end) : null,
      } as any;
    }
    if (method === "thread/turns/list")
      return {
        data: turns.has(params.threadId) ? [turns.get(params.threadId)] : [],
      } as any;
    throw new Error("Unexpected RPC: " + method);
  };
  const monitor = new CodexActivityMonitor(f.store, f.codex, {
    refresh: async () => ({
      workspaces: [],
      projects: [],
      currentBridgeCwd: process.cwd(),
    }),
    observationScope: (t) =>
      t.cwd === process.cwd()
        ? { cwd: process.cwd(), projectName: "project" }
        : undefined,
  });
  return {
    ...f,
    monitor,
    rows,
    turns,
    calls,
    setFail: (v: boolean) => {
      fail = v;
    },
    setBefore: (v: typeof before) => {
      before = v;
    },
  };
}
test("desktop activity discovers two external running conversations without dispatch or WeChat messages", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  f.rows.push(
    thread("a", { status: { type: "active", activeFlags: [] } }),
    thread("b", {
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    }),
  );
  for (const id of ["a", "b"])
    f.turns.set(id, {
      id: id + "-turn",
      status: "inProgress",
      startedAt: sec(now),
      completedAt: null,
    });
  await f.monitor.tick(now);
  const s = f.monitor.snapshot(now);
  assert.equal(s.running, 1);
  assert.equal(s.waiting, 1);
  assert.equal(s.threads.length, 2);
  assert.equal(s.crossClientRuntime, false);
  assert.ok(
    f.calls.every((c) =>
      ["thread/list", "thread/turns/list"].includes(c.method),
    ),
  );
  assert.ok(
    f.calls
      .filter((c) => c.method === "thread/list")
      .every(
        (c) =>
          Array.isArray(c.params.modelProviders) &&
          c.params.modelProviders.length === 0,
      ),
  );
  assert.equal(f.tasks.tasks().length, 0);
  assert.equal(f.store.all("notification_deliveries").length, 0);
});
test("cross-client notLoaded/interrupted without end is observed activity, never claimed stopped or confirmed running", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  f.rows.push(thread("a"));
  f.turns.set("a", {
    id: "turn",
    status: "interrupted",
    startedAt: sec(now - 1000),
    completedAt: null,
    items: [{ type: "agentMessage", phase: "final_answer", text: "partial" }],
  });
  await f.monitor.tick(now);
  const s = f.monitor.snapshot(now);
  assert.equal(s.running, 0);
  assert.equal(s.unconfirmed, 1);
  assert.equal(s.threads[0]?.status, "recentActivity");
  assert.equal(s.threads[0]?.summary, undefined);
  assert.equal(
    f.monitor.snapshot(now + 100_000).threads[0]?.status,
    "unconfirmed",
  );
  assert.equal(f.monitor.snapshot(now + 21_000).threads[0]?.stale, true);
});
test("a completed turn supersedes observed activity; errors and disconnects mark stale rather than zero tasks", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  f.rows.push(thread("a"));
  f.turns.set("a", {
    id: "turn",
    status: "completed",
    completedAt: sec(now),
    items: [{ type: "agentMessage", phase: "final_answer", text: "结果" }],
  });
  await f.monitor.tick(now);
  assert.equal(f.monitor.snapshot(now).threads[0]?.status, "completed");
  assert.equal(f.monitor.snapshot(now).threads[0]?.summary, "结果");
  f.setFail(true);
  await f.monitor.tick(now + 5000);
  assert.equal(f.monitor.snapshot(now + 5000).status, "degraded");
  assert.equal(f.monitor.snapshot(now + 5000).threads[0]?.stale, true);
  f.codex.connected = false;
  assert.equal(f.monitor.snapshot(now + 5000).status, "disconnected");
  assert.equal(f.monitor.snapshot(now + 5000).threads.length, 1);
});
test("Bridge active tasks dedupe by selected or resumed id; completed Bridge threads may run again externally", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  f.rows.push(thread("busy"), thread("past"));
  const base = { id: "one", status: "RUNNING", targetThreadId: "busy" } as Task;
  f.store.put("tasks", base);
  f.store.put("tasks", {
    ...base,
    id: "two",
    status: "COMPLETED",
    targetThreadId: "past",
    threadId: "past",
  });
  await f.monitor.tick(now);
  assert.deepEqual(
    f.monitor.snapshot(now).threads.map((r) => r.id),
    ["past"],
  );
});
test("QA, subagents, test workspaces, foreign owners and out-of-scope directories stay excluded", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  f.store.setSetting("boundUser", "other");
  f.store.put("codex_sessions", { id: "foreign", origin: "bridge" });
  f.store.setSetting("boundUser", "owner");
  f.store.put("codex_sessions", { id: "qa", origin: "qa" });
  f.rows.push(
    thread("foreign"),
    thread("qa"),
    thread("agent", { source: { subAgent: "spawn" } }),
    thread("test", { cwd: process.cwd() + "/test-output/smoke" }),
    thread("outside", { cwd: "/elsewhere" }),
    thread("ok"),
  );
  await f.monitor.tick(now);
  assert.deepEqual(
    f.monitor.snapshot(now).threads.map((r) => r.id),
    ["ok"],
  );
  assert.deepEqual(
    f.calls
      .filter((c) => c.method === "thread/turns/list")
      .map((c) => c.params.threadId),
    ["ok"],
  );
});
test("owner change during an RPC discards all old content; restart does not reuse runtime status", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  f.rows.push(thread("a"));
  await f.monitor.tick(now);
  f.setBefore((method) => {
    if (method === "thread/turns/list")
      f.store.setSetting("boundUser", "new-owner");
  });
  await f.monitor.tick(now + 5000);
  assert.equal(f.monitor.snapshot(now + 5000).threads.length, 0);
  f.setBefore(undefined);
  f.codex.connectionId = "00000000-0000-0000-0000-000000000001";
  assert.equal(f.monitor.snapshot(now + 5000).threads.length, 0);
});
test("polling is single flight, bounded, paginated, and archived conversations disappear after scan", async (t) => {
  const f = await setup();
  t.after(() => f.store.close());
  for (let i = 0; i < 65; i++)
    f.rows.push(thread(String(i), { updatedAt: sec(now - i * 1000) }));
  await Promise.all([
    f.monitor.tick(now),
    f.monitor.tick(now),
    f.monitor.tick(now),
  ]);
  assert.equal(f.calls.filter((c) => c.method === "thread/list").length, 1);
  assert.equal(
    f.calls.filter((c) => c.method === "thread/turns/list").length,
    6,
  );
  assert.equal(f.monitor.snapshot(now).paginationComplete, false);
  assert.equal(
    f.monitor.snapshot(now).unconfirmed,
    0,
    "unread historical rows are not counted as unfinished work",
  );
  await f.monitor.tick(now + 5000);
  assert.equal(f.monitor.snapshot(now + 5000).threads.length, 65);
  assert.equal(f.monitor.snapshot(now + 5000).paginationComplete, true);
  f.rows.splice(0);
  await f.monitor.tick(now + 10000);
  assert.equal(f.monitor.snapshot(now + 10000).threads.length, 0);
});
test("workspace observation checks canonical project membership and foreign owner roots", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const catalog = new WorkspaceCatalog(
    f.codex,
    f.config,
    () => [],
    () => f.store.setting("boundUser", ""),
  );
  f.codex.threads.set("legacy", thread("legacy"));
  f.codex.projects.set("foreign", {
    id: "foreign",
    name: "foreign",
    roots: [{ path: process.cwd() }],
    metadata: { bridgeOwner: "different-owner" },
  });
  await catalog.refresh();
  assert.equal(
    catalog.observationScope({ cwd: process.cwd(), projectId: "foreign" }),
    undefined,
  );
  assert.equal(
    catalog.observationScope({ cwd: process.cwd(), projectId: null }),
    undefined,
  );
  assert.equal(
    catalog.observationScope({ cwd: process.cwd(), projectId: "unrelated" }),
    undefined,
  );
});
