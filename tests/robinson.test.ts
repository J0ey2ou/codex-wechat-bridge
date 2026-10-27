import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/store.js";
import { MemoryManager } from "../src/app/memory.js";
import { OpenAIAuth, officialAuthUrl } from "../src/codex/auth.js";
import { ObservedCodex, type InferenceRecord } from "../src/codex/evidence.js";
import { MockCodex } from "../src/codex/mock.js";
import { Bridge } from "../src/app/bridge.js";
import { createApi } from "../src/api/server.js";
import { fixture } from "./helpers.js";

test("memory and business context survive restart but never follow another binding", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "robinson-memory-"));
  const file = path.join(dir, "store.sqlite");
  let store = new Store(file);
  try {
    store.setSetting("boundUser", "alice");
    let memory = new MemoryManager(store);
    memory.save("alice", "喜欢先看结论", "explicit");
    const id = memory.list("alice")[0]!.id;
    store.put("tasks", { id: "alice-task", title: "private project" });
    store.close();
    store = new Store(file);
    memory = new MemoryManager(store);
    assert.equal(memory.list("alice")[0]?.text, "喜欢先看结论");
    store.setSetting("boundUser", "bob");
    assert.deepEqual(memory.list("bob"), []);
    assert.deepEqual(store.all("tasks"), []);
    assert.equal(store.get("tasks", "alice-task"), undefined);
    assert.throws(() => store.put("tasks", { id: "alice-task" }));
    assert.throws(() => memory.remove("bob", id));
    assert.throws(() => memory.profile("alice"));
    memory.save("bob", "喜欢详细解释", "dashboard");
    store.setSetting("boundUser", "alice");
    assert.equal(memory.list("alice").length, 1);
    assert.equal(store.all("tasks").length, 1);
  } finally {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("style learns from repeated direct feedback; manual preference wins and disable stops learning", () => {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "u");
  const memory = new MemoryManager(store);
  for (let i = 0; i < 2; i++) memory.observe("u", "简短点", 0);
  assert.equal(memory.context("u").detail, "adaptive");
  memory.observe("u", "简短点", 0);
  assert.equal(memory.context("u").detail, "brief");
  memory.observe("u", "转发：详细一点", 0);
  assert.equal(memory.profile("u").detailedSignals, 0);
  memory.update("u", { detail: "detailed" });
  assert.equal(memory.context("u").detail, "detailed");
  memory.update("u", { enabled: false });
  const before = memory.profile("u").exchanges;
  memory.observe("u", "简短点", memory.profile("u").revision);
  assert.equal(memory.profile("u").exchanges, before);
  assert.equal(memory.context("u").memories, undefined);
  assert.throws(() => memory.save("u", "ignored", "explicit"));
  store.close();
});

test("v2 migration assigns existing records once to the existing bound user", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "robinson-migrate-"));
  const file = path.join(dir, "old.sqlite");
  let store = new Store(file);
  try {
    store.setSetting("boundUser", "original");
    store.put("projects", {
      id: "existing",
      name: "existing project",
      sessionId: "keep-thread",
    });
    store.db.exec(
      "UPDATE projects SET data=json_remove(data,'$.ownerId'); DELETE FROM schema_migrations WHERE version=3",
    );
    store.close();
    store = new Store(file);
    assert.equal(
      store.get<any>("projects", "existing").sessionId,
      "keep-thread",
    );
    store.setSetting("boundUser", "new-user");
    assert.deepEqual(store.all("projects"), []);
    store.close();
    store = new Store(file);
    assert.deepEqual(store.all("projects"), []);
    store.setSetting("boundUser", "original");
    assert.equal(store.all("projects").length, 1);
  } finally {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed collection and recovery cannot import another user's messages", async () => {
  const f = await fixture();
  f.store.put("messages", {
    id: "other-collection",
    userId: "other",
    text: "private reminder",
    status: "received",
    collectAt: 1,
    receivedAt: 1,
  });
  f.store.put("messages", {
    id: "other-recovery",
    userId: "other",
    text: "private task",
    status: "processing",
  });
  f.todos.collect();
  f.router.recover();
  assert.deepEqual(f.todos.list(), []);
  assert.deepEqual(f.store.all("notification_deliveries"), []);
  f.store.close();
});

test("editing or deleting memory rotates QA context; clearing history prevents replay", async () => {
  const f = await fixture();
  const memory = new MemoryManager(f.store);
  f.questions.enqueue("hello", "owner", "first");
  await f.decide("first", { reply: "before-edit" });
  const oldThread = f.store.setting("qa-session:owner", "");
  memory.save("owner", "喜欢咖啡", "dashboard");
  assert.equal(f.dispatcher.context("owner").recentResults.length, 0);
  f.questions.enqueue("hi again", "owner", "second");
  await f.decide("second", { reply: "after-edit" });
  assert.notEqual(f.store.setting("qa-session:owner", ""), oldThread);
  memory.remove("owner", memory.list("owner")[0]!.id);
  assert.equal(f.dispatcher.context("owner").recentResults.length, 0);
  assert.equal(memory.list("owner").length, 0);
  f.store.put("messages", { id: "replay", userId: "owner", text: "private" });
  memory.clear("owner", true);
  assert.equal(f.store.all("questions").length, 0);
  assert.equal(
    JSON.stringify(f.store.get("messages", "replay")).includes("private"),
    false,
  );
  await f.router.receive({
    id: "replay",
    userId: "owner",
    text: "run this",
    kind: "direct",
    sentAt: Date.now(),
  });
  assert.equal(f.store.all("questions").length, 0);
  f.store.close();
});

test("natural memory decisions only access the current user's records", async () => {
  const f = await fixture();
  f.questions.enqueue("记住我喜欢简洁", "owner", "remember");
  await f.decide("remember", { action: "memory_save", text: "喜欢简洁" });
  const memory = new MemoryManager(f.store);
  assert.equal(memory.list("owner")[0]?.text, "喜欢简洁");
  f.questions.enqueue("你记住了什么", "owner", "list");
  assert.match(
    (await f.decide("list", { action: "memory_list" })).answer!,
    /喜欢简洁/,
  );
  assert.throws(() =>
    memory.save("owner", "密码：secret-password", "dashboard"),
  );
  f.store.close();
});

test("official login handles early completion, stale events, cancellation and URL validation", async () => {
  const codex = new MockCodex();
  await codex.connect();
  let mode = "early",
    sequence = 0;
  let requiresOpenaiAuth = true;
  codex.request = async <T>(method: string, params: any = {}): Promise<T> => {
    codex.calls.push({ method, params });
    if (method === "account/read")
      return { account: { type: "chatgpt" }, requiresOpenaiAuth } as T;
    if (method === "account/login/start") {
      const id = "login-" + ++sequence;
      if (mode === "early")
        codex.emit("account/login/completed", { loginId: id, success: true });
      return {
        type: "chatgpt",
        loginId: id,
        authUrl: "https://auth.openai.com/authorize?state=private",
      } as T;
    }
    return {} as T;
  };
  const auth = new OpenAIAuth(codex);
  await auth.start();
  assert.equal((await auth.status()).loginState, "completed");
  mode = "pending";
  await auth.start();
  codex.emit("account/login/completed", { loginId: "login-1", success: true });
  assert.equal((await auth.status()).pending, true);
  assert.equal(JSON.stringify(await auth.status()).includes("private"), false);
  await auth.cancel();
  assert.equal((await auth.status()).pending, false);
  assert.ok(
    codex.calls.some(
      (c) =>
        c.method === "account/login/cancel" && c.params.loginId === "login-2",
    ),
  );
  await auth.start();
  assert.equal(auth.busy, true);
  codex.emit("account/login/completed", {
    loginId: "login-3",
    success: false,
    error: "private-url-must-not-be-exposed",
  });
  assert.equal((await auth.status()).loginState, "failed");
  assert.equal(auth.busy, false);
  assert.equal(
    JSON.stringify(await auth.status()).includes("private-url"),
    false,
  );
  for (const url of [
    "http://auth.openai.com/",
    "https://auth.openai.com.evil.test",
    "javascript:alert(1)",
    "https://user:pass@auth.openai.com/",
  ])
    assert.throws(() => officialAuthUrl(url));
  await assert.rejects(new OpenAIAuth(codex, true).start(), /Mock/);
  requiresOpenaiAuth = false;
  assert.equal((await auth.status()).billingSource, "unknown");
});

test("evidence distinguishes configured model from reported model, usage and auth billing", async () => {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "u");
  const base = new MockCodex();
  await base.connect();
  const original = base.request.bind(base);
  base.request = async <T>(method: string, p: any = {}): Promise<T> => {
    if (method === "account/read")
      return { account: { type: "chatgpt" }, requiresOpenaiAuth: true } as T;
    const r: any = await original(method, p);
    if (method === "thread/start") r.model = "configured-model";
    return r;
  };
  const codex = new ObservedCodex(base, store, false);
  const t: any = await codex.request("thread/start", {
    developerInstructions: "智能入口",
  });
  const r: any = await codex.request("turn/start", { threadId: t.thread.id });
  let record = store.all<InferenceRecord>("inference_records")[0]!;
  assert.equal(record.actualModel, null);
  assert.equal(record.threadModel, "configured-model");
  assert.equal(record.billingSource, "chatgpt-plan");
  assert.equal(record.route, "wechat-entry");
  base.emit("thread/tokenUsage/updated", {
    threadId: t.thread.id,
    turnId: r.turn.id,
    tokenUsage: {
      last: { totalTokens: 123, inputTokens: 100, secret: "never-save" },
    },
  });
  base.emit("turn/completed", {
    threadId: t.thread.id,
    turn: { id: r.turn.id, status: "completed", model: "reported-model" },
  });
  record = store.all<InferenceRecord>("inference_records")[0]!;
  assert.equal(record.actualModel, "reported-model");
  assert.equal(record.tokens?.totalTokens, 123);
  assert.equal(JSON.stringify(record).includes("never-save"), false);
  store.setSetting("boundUser", "other");
  assert.equal(store.all("inference_records").length, 0);
  store.close();
});

test("App endpoints expose install assets, isolate memory and reject busy-account changes", async () => {
  const f = await fixture();
  f.config.codexMode = "mock";
  const bridge = new Bridge(f.config, {
    store: f.store,
    codex: f.codex,
    channel: f.channel,
  });
  const port = 33492,
    server = createApi(bridge, port),
    base = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const boot: any = await (await fetch(base + "/api/bootstrap")).json();
    assert.equal(boot.name, "鲁滨逊");
    const api = (route: string, body?: unknown) =>
      fetch(base + "/api/" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-bridge-token": boot.csrf,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const manifest: any = await (
      await fetch(base + "/manifest.webmanifest")
    ).json();
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.name, "鲁滨逊");
    assert.equal((await fetch(base + "/icon.svg")).status, 200);
    assert.equal((await api("memory/save", { text: "private" })).status, 200);
    assert.equal(
      (await api("memory/save", { text: "attack", userId: "other" })).status,
      400,
    );
    const memory: any = await (await api("memory")).json();
    assert.equal(memory.memories.length, 1);
    f.questions.enqueue("running", "owner", "busy");
    assert.equal((await api("openai/logout", {})).status, 400);
    assert.equal(
      (await api("wechat/unbind", { confirm: "本机确认" })).status,
      400,
    );
    assert.equal(
      (await api("memory/delete", { id: memory.memories[0].id })).status,
      400,
    );
    f.store.delete("questions", "busy");
    f.store.setSetting("boundUser", "other");
    assert.equal(
      (await api("memory/delete", { id: memory.memories[0].id })).status,
      400,
    );
    const state: any = await (await api("state")).json();
    assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.messageAnalysis, []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    f.store.close();
  }
});

test("early evidence events are matched to the returned turn, never to stale turn IDs", async () => {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "u");
  const base = new MockCodex();
  await base.connect();
  base.request = async <T>(method: string): Promise<T> => {
    if (method === "turn/start") {
      base.emit("turn/completed", {
        threadId: "thread",
        turn: { id: "stale", status: "completed", model: "wrong" },
      });
      base.emit("turn/completed", {
        threadId: "thread",
        turn: { id: "current", status: "completed", model: "right" },
      });
      return { turn: { id: "current", status: "inProgress" } } as T;
    }
    return {} as T;
  };
  const codex = new ObservedCodex(base, store, false);
  await codex.request("turn/start", { threadId: "thread" });
  const rows = store.all<InferenceRecord>("inference_records");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.turnId, "current");
  assert.equal(rows[0]?.actualModel, "right");
  assert.equal(rows[0]?.status, "completed");
  assert.equal(rows[0]?.billingSource, "unknown");
  store.close();
});
