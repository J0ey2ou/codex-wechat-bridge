import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/app/bridge.js";
import { createApi } from "../src/api/server.js";
import type { Delivery, Task } from "../src/app/types.js";
import type { Question } from "../src/codex/questions.js";
import { fixture } from "./helpers.js";

type Api = (route: string, body?: unknown) => Promise<Response>;

async function withApi(
  port: number,
  run: (
    context: Awaited<ReturnType<typeof fixture>> & {
      bridge: Bridge;
      api: Api;
    },
  ) => Promise<void>,
) {
  const f = await fixture();
  f.config.codexMode = f.config.wechatMode = "mock";
  const bridge = new Bridge(f.config, {
    store: f.store,
    codex: f.codex,
    channel: f.channel,
  });
  const server = createApi(bridge, port);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${port}`;
    const bootstrap = await fetch(base + "/api/bootstrap");
    assert.equal(bootstrap.status, 200);
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const api: Api = (route, body) =>
      fetch(base + "/api/" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-bridge-token": csrf,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await run({ ...f, bridge, api });
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    f.store.close();
  }
}

test("settings API exposes default push state and persists only submitted changes", async () => {
  await withApi(33493, async ({ bridge, store, api }) => {
    const initial: any = await (await api("state")).json();
    assert.equal(initial.settings.wechatPushEnabled, true);
    store.setSetting("preferences", { customPreference: "keep" });

    assert.equal(
      (await api("settings", { wechatPushEnabled: false })).status,
      200,
    );
    assert.equal(bridge.config.wechatPushEnabled, false);
    assert.equal(bridge.notices.isPushEnabled(), false);
    assert.deepEqual(store.setting("preferences", {}), {
      customPreference: "keep",
      wechatPushEnabled: false,
    });

    assert.equal(
      (await api("settings", { collectionMinutes: 23 })).status,
      200,
    );
    let state: any = await (await api("state")).json();
    assert.equal(state.settings.wechatPushEnabled, false);
    assert.equal(state.settings.collectionMinutes, 23);
    assert.equal(
      (store.setting("preferences", {}) as any).wechatPushEnabled,
      false,
    );

    assert.equal(
      (await api("settings", { wechatPushEnabled: true })).status,
      200,
    );
    state = await (await api("state")).json();
    assert.equal(state.settings.wechatPushEnabled, true);
    assert.equal(bridge.config.wechatPushEnabled, true);
    assert.deepEqual(store.setting("preferences", {}), {
      customPreference: "keep",
      wechatPushEnabled: true,
      collectionMinutes: 23,
    });
  });
});

test("settings API rejects invalid push values without partially saving or muting", async () => {
  await withApi(33494, async ({ bridge, store, api }) => {
    const queued = bridge.notices.enqueue("待发送结果", "finished:valid")!;
    const before = { ...bridge.config };
    for (const value of [null, "false", 0, 1, [], {}]) {
      const response = await api("settings", {
        wechatPushEnabled: value,
        notifyProgress: !before.notifyProgress,
        collectionMinutes: 42,
      });
      assert.equal(response.status, 400, JSON.stringify(value));
      assert.match(((await response.json()) as any).error, /布尔值/);
      assert.deepEqual(bridge.config, before);
      assert.deepEqual(store.setting("preferences", {}), {});
      assert.equal(bridge.notices.isPushEnabled(), true);
      assert.equal(
        store.get<Delivery>("notification_deliveries", queued)!.status,
        "pending",
      );
    }
  });
});

test("API mute stays locally auditable, allows inbound answers and never replays suppressed pushes", async () => {
  await withApi(33495, async ({ bridge, store, channel, codex, project, api }) => {
    const task = bridge.tasks.create(project.id, "继续排队的工作");
    const storedTask = store.get<Task>("tasks", task.id);
    const pending = bridge.notices.enqueue("关闭前排队的结果", "finished:before")!;
    assert.equal(
      (await api("settings", { wechatPushEnabled: false })).status,
      200,
    );
    const muted = bridge.notices.enqueue("关闭期间产生的结果", "finished:muted")!;
    assert.deepEqual(store.get<Task>("tasks", task.id), storedTask);

    assert.equal(
      (await api("mock/message", { text: "什么是过拟合" })).status,
      200,
    );
    await bridge.questions.pump();
    const question = store.all<Question>("questions")[0]!;
    assert.equal(question.status, "running");
    const reply = "过拟合是模型过度记住训练数据，导致对新数据的表现变差。";
    codex.emit("item/completed", {
      threadId: question.threadId,
      turnId: question.turnId,
      item: {
        type: "agentMessage",
        text: JSON.stringify({
          action: "answer",
          reply,
          computer: null,
          projectId: null,
          taskId: null,
          todoId: null,
          approvalId: null,
          text: null,
          date: null,
          repeatMinutes: null,
          newProject: null,
        }),
      },
    });
    codex.emit("turn/completed", {
      threadId: question.threadId,
      turn: { id: question.turnId, status: "completed" },
    });
    await bridge.questions.drained();
    await bridge.notices.flush();
    assert.deepEqual(channel.sent.map((message) => message.text), [reply]);

    let state: any = await (await api("state")).json();
    for (const id of [pending, muted]) {
      const delivery = state.deliveries.find((row: Delivery) => row.id === id);
      assert.equal(delivery.status, "suppressed");
      assert.equal(delivery.attempts, 0);
      assert.ok(delivery.suppressedAt);
    }
    const answer = state.deliveries.find(
      (row: Delivery) => row.dedupeKey === `answer:${question.id}`,
    );
    assert.equal(answer.kind, "reply");
    assert.equal(answer.status, "server_accepted");

    assert.equal(
      (await api("settings", { wechatPushEnabled: true })).status,
      200,
    );
    await bridge.notices.flush();
    assert.equal(channel.sent.length, 1);
    bridge.notices.enqueue("重新开启后的新结果", "finished:new");
    await bridge.notices.flush();
    assert.deepEqual(channel.sent.map((message) => message.text), [
      reply,
      "重新开启后的新结果",
    ]);
    state = await (await api("state")).json();
    assert.equal(state.settings.wechatPushEnabled, true);
    assert.deepEqual(store.get<Task>("tasks", task.id), storedTask);
    assert.ok(
      state.deliveries
        .filter((row: Delivery) => [pending, muted].includes(row.id))
        .every((row: Delivery) => row.status === "suppressed"),
    );
  });
});
