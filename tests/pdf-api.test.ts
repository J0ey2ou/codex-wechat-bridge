import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bridge } from "../src/app/bridge.js";
import { createApi } from "../src/api/server.js";
import { loadConfig } from "../src/app/config.js";
import { Store } from "../src/storage/store.js";
import { MockCodex } from "../src/codex/mock.js";
import { MockWeChat } from "../src/channels/wechat/mock.js";

test("PDF download is authenticated and owned; managed stop refuses pending work", async (t) => {
  const config = loadConfig("nonexistent.json");
  config.dataDir = mkdtempSync(path.join(tmpdir(), "pdf-api-"));
  const store = new Store(":memory:");
  store.setSetting("boundUser", "owner");
  const bridge = new Bridge(config, {
    store,
    codex: new MockCodex(),
    channel: new MockWeChat(),
  });
  const port = 33538,
    server = createApi(bridge, port);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base = `http://127.0.0.1:${port}`;
  const boot = (await (await fetch(base + "/api/bootstrap")).json()) as any;
  assert.ok(boot.build.id);
  const post = (route: string, body: unknown, token = boot.csrf) =>
    fetch(base + "/api/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify(body),
    });
  const report = await bridge.reports.create(
    "owner",
    "source",
    "API 报告",
    "报告正文。",
  );
  assert.equal(
    (await post("reports/download", { id: report.id }, "bad")).status,
    403,
  );
  const response = await post("reports/download", { id: report.id });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.ok(response.headers.get("content-disposition")?.includes("UTF-8"));
  assert.equal(
    Buffer.from(await response.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    "%PDF-",
  );
  store.setSetting("boundUser", "other");
  assert.notEqual(
    (await post("reports/download", { id: report.id })).status,
    200,
  );
  let stopped = false;
  bridge.onShutdown = () => {
    stopped = true;
  };
  store.put("questions", { id: "busy", userId: "other", status: "running" });
  assert.notEqual((await post("runtime/stop", {})).status, 200);
  assert.equal(stopped, false);
  store.delete("questions", "busy");
  assert.equal((await post("runtime/stop", {})).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, true);
});
