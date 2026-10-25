import test from "node:test";
import assert from "node:assert/strict";
import { AppServerClient } from "../src/codex/client.js";
import type { RpcEvent } from "../src/app/types.js";
test("real stdio transport handshake, request correlation, events, resume, interrupt, reconnect", async () => {
  const c = new AppServerClient(
    process.execPath,
    ["tests/fixtures/rpc-server.mjs"],
    2000,
  );
  const events: RpcEvent[] = [];
  c.onEvent((e) => events.push(e));
  try {
    await c.connect();
    const id = c.connectionId;
    assert.equal(c.connected, true);
    assert.equal((await c.request("thread/start")).thread.id, "thread-test");
    await c.request("thread/resume", { threadId: "thread-test" });
    await c.request("turn/start");
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(events.some((e) => e.method === "item/started"));
    await c.request("turn/interrupt");
    await c.reconnect();
    assert.notEqual(c.connectionId, id);
    assert.equal(c.connected, true);
  } finally {
    await c.disconnect();
  }
});
test("stdio request timeout and lost connection reject without replay", async () => {
  const c = new AppServerClient(
    process.execPath,
    ["tests/fixtures/rpc-server.mjs"],
    150,
  );
  try {
    await c.connect();
    await assert.rejects(c.request("hang"), /超时/);
    await assert.rejects(c.request("drop"), /连接中断/);
    assert.equal(c.connected, false);
  } finally {
    await c.disconnect();
  }
});
