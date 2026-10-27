import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage/store.js";
import { MockCodex } from "../src/codex/mock.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";
import { NotificationManager } from "../src/notifications/outbox.js";
import {
  CodexCompletionWatcher,
  type CompletionWatcherOptions,
} from "../src/codex/completion-watcher.js";
import type { Delivery } from "../src/app/types.js";

const START = Date.UTC(2026, 9, 26, 9);
const seconds = (value: number) => Math.floor(value / 1000);
function finished(id: string, at: number | null, text = `结果 ${id}`) {
  return {
    id,
    status: "completed",
    completedAt: at === null ? null : seconds(at),
    items: [{ type: "agentMessage", phase: "final_answer", text }],
  };
}
function thread(id: string, at = START - 200_000, turns: any[] = []) {
  return {
    id,
    name: `项目 ${id}`,
    cwd: `D:\\projects\\${id}`,
    createdAt: seconds(START - 300_000),
    updatedAt: seconds(at),
    source: "vscode",
    modelProvider: "openai",
    status: { type: "notLoaded" },
    turns,
  };
}
class ReadOnlyCodex extends MockCodex {
  beforeRead?: (id: string) => Promise<void> | void;
  beforeTurns?: (id: string) => Promise<void> | void;
  failList = false;
  failReads = new Set<string>();
  fullItems = new Map<string, any[]>();
  override async request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      if (this.failList) throw new Error("metadata unavailable");
      const sorted = [...this.threads.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      );
      const start = Number(params.cursor ?? 0);
      const end = start + Number(params.limit);
      return {
        data: sorted
          .slice(start, end)
          .map((entry) => ({ ...entry, turns: [] })),
        nextCursor: end < sorted.length ? String(end) : null,
      } as T;
    }
    if (method === "thread/read") {
      const id = String(params.threadId);
      await this.beforeRead?.(id);
      if (this.failReads.has(id)) throw new Error("read unavailable");
      const value = this.threads.get(id);
      return {
        thread: { ...value, turns: params.includeTurns ? value?.turns : [] },
      } as T;
    }
    if (method === "thread/turns/list") {
      await this.beforeTurns?.(String(params.threadId));
      const value = this.threads.get(String(params.threadId));
      return {
        data: [...value.turns].reverse().slice(0, Number(params.limit)),
        nextCursor: null,
      } as T;
    }
    if (method === "thread/items/list")
      return {
        data: (this.fullItems.get(String(params.turnId)) ?? [])
          .toReversed()
          .slice(0, Number(params.limit))
          .map((item) => ({ turnId: params.turnId, item })),
        nextCursor: null,
      } as T;
    throw new Error(`Unexpected mutating or unsupported RPC: ${method}`);
  }
}
async function fixture(options: CompletionWatcherOptions = {}) {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "owner");
  const codex = new ReadOnlyCodex();
  await codex.connect();
  const notices = new NotificationManager(store, new MockWeChat());
  const watcher = new CodexCompletionWatcher(store, codex, notices, options);
  return {
    store,
    codex,
    notices,
    watcher,
    deliveries: () => store.all<Delivery>("notification_deliveries"),
    reads: () => codex.calls.filter((call) => call.method === "thread/read"),
  };
}

test("startup baselines historical completions; changed desktop threads notify with all providers and read-only RPCs", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const value = thread("desktop", START - 200_000, [
    finished("old", START - 200_000),
  ]);
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START);
  assert.equal(f.deliveries().length, 0);
  assert.equal(f.reads().length, 0, "old unchanged history is not hydrated");
  await f.watcher.tick(START + 20_000);
  assert.equal(f.reads().length, 0);
  value.updatedAt = seconds(START + 30_000);
  value.turns.push(
    finished("new", START + 30_000, "修复完成；测试通过 12 项。"),
  );
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 1);
  assert.match(f.deliveries()[0]!.text, /修复完成；测试通过 12 项/);
  assert.match(f.deliveries()[0]!.text, /有新结果了/);
  assert.equal(f.deliveries()[0]!.userId, "owner");
  assert.ok(
    f.codex.calls.every((call) =>
      ["thread/list", "thread/read"].includes(call.method),
    ),
  );
  assert.deepEqual(f.codex.calls[0]!.params.modelProviders, []);
  assert.equal(f.watcher.snapshot().status, "watching");
});

test("cross-process interrupted/notLoaded is not completion; an initially running turn can later finish", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const value = thread("running", START, [
    { id: "ongoing", status: "interrupted", items: [] },
  ]);
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START);
  assert.equal(f.deliveries().length, 0);
  value.turns[0] = { ...finished("ongoing", null), status: "interrupted" };
  await f.watcher.tick(START + 20_000);
  assert.equal(
    f.deliveries().length,
    0,
    "even a final-looking message is insufficient without completed",
  );
  value.turns[0] = finished("ongoing", null, "现在已经完成。");
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 1);
  await f.watcher.tick(START + 60_000);
  assert.equal(f.deliveries().length, 1);
});

test("overlap detects multiple turns within the same updatedAt second and persists dedupe on restart", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const value = thread("same-second", START, [finished("baseline", START)]);
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START);
  assert.equal(f.deliveries().length, 0);
  value.turns.push(finished("later-in-same-second", START));
  await f.watcher.tick(START + 15_000);
  assert.equal(f.deliveries().length, 1);
  const restarted = new CodexCompletionWatcher(f.store, f.codex, f.notices);
  await restarted.tick(START + 30_000);
  assert.equal(f.deliveries().length, 1);
  value.updatedAt = seconds(START + 45_000);
  value.turns.push(finished("next", START + 45_000));
  await restarted.tick(START + 45_000);
  assert.equal(f.deliveries().length, 2);
});

test("only a verifiable final answer is forwarded; failures, commentary, absent items and turn errors stay quiet", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  const cases = [
    { ...finished("failed", START + 1_000), status: "failed" },
    { ...finished("error", START + 1_000), error: { message: "broken" } },
    {
      ...finished("commentary", START + 1_000),
      items: [{ type: "agentMessage", phase: "commentary", text: "正在处理" }],
    },
    { ...finished("no-items", START + 1_000), items: [] },
    { ...finished("summary", START + 1_000), itemsView: "notLoaded" },
    {
      ...finished("tool-after-message", START + 1_000),
      items: [
        { type: "agentMessage", text: "先运行检查" },
        { type: "commandExecution" },
      ],
    },
  ];
  for (const item of cases)
    f.codex.threads.set(item.id, thread(item.id, START + 1_000, [item]));
  await f.watcher.tick(START + 20_000);
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 0);
  const value = f.codex.threads.get("no-items");
  value.updatedAt = seconds(START + 50_000);
  value.turns = [finished("no-items", START + 1_000, "现在有完整最终结果。")];
  await f.watcher.tick(START + 60_000);
  await f.watcher.tick(START + 80_000);
  assert.equal(f.deliveries().length, 1);
  assert.match(f.deliveries()[0]!.text, /完整最终结果/);
});

test("Bridge tasks, QA sessions, internal sessions, smoke tests and subagents are never notified", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  f.store.put("tasks", { id: "task-record", threadId: "task" });
  f.store.put("questions", {
    id: "qa-record",
    threadId: "question",
    userId: "owner",
  });
  f.store.put("codex_sessions", { id: "qa-session", origin: "qa" });
  f.store.put("codex_sessions", { id: "fork", origin: "desktop-fork" });
  for (const id of [
    "task",
    "question",
    "qa-session",
    "fork",
    "smoke",
    "smoke-path",
    "child",
    "ephemeral",
  ])
    f.codex.threads.set(
      id,
      thread(id, START + 1_000, [finished(id, START + 1_000)]),
    );
  f.codex.threads.get("smoke").preview =
    "This is an integration connectivity smoke test. Reply exactly BRIDGE_OK.";
  f.codex.threads.get("smoke-path").cwd =
    "D:\\codex-wechat\\test-output\\bound-smoke\\workspace";
  f.codex.threads.get("child").parentThreadId = "parent";
  f.codex.threads.get("ephemeral").ephemeral = true;
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 0);
  assert.equal(f.reads().length, 0);
});

test("a renamed historical turn without timestamps is not mistaken for a new result", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const value = thread("old", START - 200_000, [finished("untimed-old", null)]);
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START);
  value.name = "刚修改的会话名称";
  value.updatedAt = seconds(START + 20_000);
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 0);
  value.turns.push(finished("new-untimed", null));
  await f.watcher.tick(START + 40_000);
  assert.equal(
    f.deliveries().length,
    1,
    "previously hydrated full history proves this turn is new",
  );
});

test("metadata pagination and content budgets continue fairly across ticks", async (t) => {
  const f = await fixture({
    pageSize: 2,
    maxPagesPerTick: 1,
    maxReadsPerTick: 2,
  });
  t.after(() => f.store.close());
  for (let index = 0; index < 5; index++) {
    const id = String(index);
    f.codex.threads.set(
      id,
      thread(id, START, [finished("old", START - 1_000)]),
    );
  }
  await f.watcher.tick(START);
  assert.equal(f.watcher.snapshot().status, "baselining");
  await f.watcher.tick(START + 20_000);
  await f.watcher.tick(START + 40_000);
  assert.equal(f.watcher.snapshot().status, "watching");
  assert.equal(f.watcher.snapshot().trackedThreads, 5);
  assert.deepEqual(
    f.codex.calls
      .filter((call) => call.method === "thread/list")
      .map((call) => call.params.cursor),
    [undefined, "2", "4"],
  );
  assert.equal(f.deliveries().length, 0);
  for (const value of f.codex.threads.values()) {
    value.updatedAt = seconds(START + 50_000);
    value.turns.push(finished("new", START + 50_000));
  }
  let previousReads = f.reads().length;
  for (let index = 0; index < 5; index++) {
    await f.watcher.tick(START + 60_000 + index * 20_000);
    assert.ok(f.reads().length - previousReads <= 2);
    previousReads = f.reads().length;
  }
  assert.equal(f.deliveries().length, 5);
});

test("multiple newly completed turns in one thread are coalesced and consumed once", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  const value = thread("busy-project", START + 3_000, [
    finished("one", START + 1_000, "第一轮结果"),
    finished("two", START + 2_000, "第二轮结果"),
    finished("three", START + 3_000, "第三轮结果"),
  ]);
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START + 20_000);
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 1);
  assert.match(f.deliveries()[0]!.text, /第三轮结果/);
  assert.doesNotMatch(f.deliveries()[0]!.text, /第一轮结果/);
});

test("owner rebind creates a fresh baseline and an in-flight read cannot send to either owner", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  const value = thread("private-result", START + 1_000, [
    finished("first", START + 1_000),
  ]);
  f.codex.threads.set(value.id, value);
  f.codex.beforeRead = () => {
    f.store.setSetting("boundUser", "other");
  };
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 0);
  f.codex.beforeRead = undefined;
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 0);
  value.updatedAt = seconds(START + 50_000);
  value.turns.push(finished("second", START + 50_000));
  await f.watcher.tick(START + 60_000);
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.deliveries()[0]!.userId, "other");
  f.store.setSetting("boundUser", "owner");
  await f.watcher.tick(START + 80_000);
  assert.equal(
    f.deliveries().length,
    1,
    "returning owner does not inherit activity during the other binding",
  );
});

test("errors are isolated and enqueue failures are retried without committing completion", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.codex.failList = true;
  await assert.doesNotReject(f.watcher.tick(START));
  assert.match(f.watcher.snapshot().error ?? "", /metadata unavailable/);
  f.codex.failList = false;
  await f.watcher.tick(START + 20_000);
  f.codex.threads.set(
    "result",
    thread("result", START + 30_000, [finished("result", START + 30_000)]),
  );
  f.codex.failReads.add("result");
  await assert.doesNotReject(f.watcher.tick(START + 40_000));
  assert.equal(f.deliveries().length, 0);
  f.codex.failReads.clear();
  const enqueue = f.notices.enqueue.bind(f.notices);
  f.notices.enqueue = () => {
    throw new Error("outbox unavailable");
  };
  await assert.doesNotReject(f.watcher.tick(START + 60_000));
  assert.equal(f.deliveries().length, 0);
  f.notices.enqueue = enqueue;
  await f.watcher.tick(START + 80_000);
  assert.equal(f.deliveries().length, 1);
});

test("paginated history uses public metadata and turn reads without loading or resuming the thread", async (t) => {
  const f = await fixture({ maxReadsPerTick: 2 });
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  f.codex.threads.set("paged", {
    ...thread("paged", START + 1_000, [finished("paged-turn", START + 1_000)]),
    historyMode: "paginated",
  });
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.reads()[0]!.params.includeTurns, false);
  const page = f.codex.calls.find(
    (call) => call.method === "thread/turns/list",
  )!;
  assert.deepEqual(page.params, {
    threadId: "paged",
    limit: 20,
    itemsView: "summary",
    sortDirection: "desc",
  });
  assert.ok(
    f.codex.calls.every((call) =>
      ["thread/list", "thread/read", "thread/turns/list"].includes(call.method),
    ),
  );
});

test("unbound/disconnected checks stay quiet, polling is throttled and notification summaries are bounded and redacted", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.store.setSetting("boundUser", null);
  await f.watcher.tick(START);
  assert.equal(f.codex.calls.length, 0);
  assert.equal(f.watcher.snapshot().status, "waitingForBinding");
  f.store.setSetting("boundUser", "owner");
  f.codex.connected = false;
  await f.watcher.tick(START);
  assert.equal(f.watcher.snapshot().status, "disconnected");
  f.codex.connected = true;
  await f.watcher.tick(START);
  await f.watcher.tick(START + 1_000);
  assert.equal(f.codex.calls.length, 1);
  f.codex.threads.set(
    "long",
    thread("long", START + 2_000, [
      finished(
        "long",
        START + 2_000,
        "api_key=secretvalue\n" + "结果".repeat(2000),
      ),
    ]),
  );
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 1);
  assert.ok(f.deliveries()[0]!.text.length < 2400);
  assert.doesNotMatch(f.deliveries()[0]!.text, /secretvalue/);
});

test("public summaries with final_answer are sufficient; a missing summary uses a bounded targeted item read", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  const value = {
    ...thread("summary-project", START + 1_000, [
      { ...finished("summary-turn", START + 1_000), itemsView: "summary" },
    ]),
    historyMode: "paginated",
  };
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 1);
  assert.equal(
    f.codex.calls.filter((call) => call.method === "thread/items/list").length,
    0,
  );
  value.updatedAt = seconds(START + 30_000);
  value.turns.push({
    ...finished("missing-summary", START + 30_000),
    itemsView: "summary",
    items: [],
  });
  f.codex.fullItems.set("missing-summary", [
    { type: "agentMessage", phase: "commentary", text: "处理中" },
    { type: "agentMessage", phase: "final_answer", text: "定向查到的最终结果" },
  ]);
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 2);
  assert.ok(
    f
      .deliveries()
      .some((delivery) => delivery.text.includes("定向查到的最终结果")),
  );
  assert.deepEqual(
    f.codex.calls.find((call) => call.method === "thread/items/list")!.params,
    {
      threadId: value.id,
      turnId: "missing-summary",
      limit: 10,
      sortDirection: "desc",
    },
  );
});

test("muting records suppressed completions and re-enabling never replays those results", async (t) => {
  let clock = START;
  t.mock.method(Date, "now", () => clock);
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  clock = START + 500;
  f.notices.setPushEnabled(false);
  const value = thread("muted", START + 1_000, [
    finished("muted-turn", START + 1_000),
  ]);
  f.codex.threads.set(value.id, value);
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.deliveries()[0]!.status, "suppressed");
  clock = START + 30_000;
  f.notices.setPushEnabled(true);
  await f.watcher.tick(START + 40_000);
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.deliveries()[0]!.status, "suppressed");
  value.updatedAt = seconds(START + 50_000);
  value.turns.push(finished("enabled-turn", START + 50_000));
  await f.watcher.tick(START + 60_000);
  assert.equal(f.deliveries().length, 2);
  assert.equal(
    f.deliveries().filter((delivery) => delivery.status === "pending").length,
    1,
  );
});

test("a completion first discovered after re-enabling remains suppressed when it occurred during mute", async (t) => {
  let clock = START;
  t.mock.method(Date, "now", () => clock);
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  clock = START + 1_000;
  f.notices.setPushEnabled(false);
  const value = thread("late-discovery", START + 10_000, [
    finished("completed-while-muted", START + 10_000),
  ]);
  f.codex.threads.set(value.id, value);
  clock = START + 20_000;
  f.notices.setPushEnabled(true);
  // No watcher tick took place while notifications were muted.
  clock = START + 30_000;
  await f.watcher.tick(clock);
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.deliveries()[0]!.status, "suppressed");
  clock = START + 50_000;
  value.updatedAt = seconds(START + 40_000);
  value.turns.push(finished("completed-after-reenable", START + 40_000));
  await f.watcher.tick(clock);
  assert.equal(f.deliveries().length, 2);
  assert.equal(
    f.deliveries().filter((delivery) => delivery.status === "pending").length,
    1,
  );
});

test("a desktop thread adopted by a Bridge task during a read does not produce a duplicate notification", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await f.watcher.tick(START);
  f.codex.threads.set("adopted", {
    ...thread("adopted", START + 1_000, [
      finished("adopted-turn", START + 1_000),
    ]),
    historyMode: "paginated",
  });
  f.codex.beforeTurns = (threadId) => {
    f.store.put("tasks", { id: "new-bridge-task", threadId });
  };
  await f.watcher.tick(START + 20_000);
  assert.equal(f.deliveries().length, 0);
});
