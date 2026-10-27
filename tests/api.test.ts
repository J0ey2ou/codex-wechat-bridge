import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/app/bridge.js";
import { createApi } from "../src/api/server.js";
import { fixture } from "./helpers.js";
import { request as httpRequest } from "node:http";
test("HTTP control is localhost-only, rejects CSRF/host spoof and keeps secrets out of state", async () => {
  const f = await fixture();
  const bridge = new Bridge(f.config, {
    store: f.store,
    codex: f.codex,
    channel: f.channel,
  });
  const port = 33491;
  const server = createApi(bridge, port);
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    let r = await fetch(base + "/");
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes("Codex WeChat Bridge"));
    r = await fetch(base + "/api/state");
    assert.equal(r.status, 403);
    const boot = (await (await fetch(base + "/api/bootstrap")).json()) as any;
    r = await fetch(base + "/api/state", {
      headers: { "x-bridge-token": boot.csrf },
    });
    assert.equal(r.status, 200);
    const state = (await r.json()) as any;
    assert.equal(state.boundUser, "owner");
    assert.equal(JSON.stringify(state).includes("csrf"), false);
    assert.equal(state.messageLatency.modelRound.samples, 0);
    assert.equal(state.messageLatency.sendRequest.medianMs, null);
    assert.equal(
      state.capabilities.desktopActivity,
      "read-only-observation-v1",
    );
    assert.deepEqual(state.desktopActivity.threads, []);
    r = await fetch(base + "/api/activity/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 403);
    r = await fetch(base + "/api/notification-report");
    assert.equal(r.status, 403);
    r = await fetch(base + "/api/notification-report", {
      headers: { "x-bridge-token": boot.csrf },
    });
    assert.equal(r.status, 200);
    const report = (await r.json()) as { text: string };
    assert.match(report.text, /模拟通道|未停止或重启/);
    r = await fetch(base + "/api/project-issues");
    assert.equal(r.status, 403);
    r = await fetch(base + "/api/project-issues", {
      headers: { "x-bridge-token": boot.csrf },
    });
    assert.equal(r.status, 200);
    assert.match(((await r.json()) as { text: string }).text, /文献打包/);
    assert.deepEqual(state.routingRequests, []);
    r = await fetch(base + "/api/tasks/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": boot.csrf,
        Origin: "https://evil.test",
      },
      body: JSON.stringify({ projectId: f.project.id, title: "attack" }),
    });
    assert.equal(r.status, 403);
    const spoofedStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          base + "/api/bootstrap",
          { headers: { Host: "evil.test" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    assert.equal(spoofedStatus, 403);
    assert.equal(f.tasks.tasks().length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
