import test from "node:test";
import assert from "node:assert/strict";
import {
  computerCall,
  normalizeComputerCall,
  COMPUTER_SCHEMA,
} from "../src/computer/protocol.js";
import { ComputerService } from "../src/computer/service.js";
import type { WorkspaceCatalog } from "../src/computer/workspaces.js";
import type { AppCatalog } from "../src/computer/apps.js";

test("structured computer calls round-trip as typed requests with nullable fields removed", () => {
  const call = computerCall({
    tool: "database_query",
    id: "real-root",
    path: "data/tasks.db",
    table: "todos",
    columns: ["title"],
    filters: [{ column: "done", op: "eq", value: 0 }],
    limit: 5,
  });
  assert.equal(call.query, null);
  assert.equal(call.offset, null);
  assert.deepEqual(
    Object.keys(call).sort(),
    [...COMPUTER_SCHEMA.required].sort(),
  );
  assert.deepEqual(normalizeComputerCall(call), {
    tool: "database_query",
    id: "real-root",
    path: "data/tasks.db",
    table: "todos",
    columns: ["title"],
    filters: [{ column: "done", op: "eq", value: 0 }],
    limit: 5,
  });
  assert.deepEqual(
    normalizeComputerCall(computerCall({ tool: "apps", query: "应用" })),
    { tool: "apps", query: "应用" },
  );
});

test("computer protocol rejects text, nested JSON strings, missing fields and arbitrary tools", () => {
  const missingField = { ...computerCall({ tool: "apps" }) } as Record<
    string,
    unknown
  >;
  delete missingField.id;
  for (const value of [
    null,
    [],
    "打开软件",
    JSON.stringify({ tool: "apps" }),
    { tool: "apps" },
    missingField,
    { ...computerCall({ tool: "apps" }), extra: "unknown" },
    computerCall({ tool: "shell" }),
    {
      ...computerCall({ tool: "open_app", id: "app" }),
      command: "powershell.exe",
    },
    { ...computerCall({ tool: "database_query" }), sql: "DROP TABLE todos" },
  ])
    assert.throws(() => normalizeComputerCall(value), /computer/);
});

test("computer protocol validates structured argument types and filter bounds", () => {
  const base = computerCall({ tool: "database_query" });
  for (const changes of [
    { id: 1 },
    { query: false },
    { path: {} },
    { table: [] },
    { query: "x".repeat(4097) },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.NaN },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 101 },
    { limit: Number.POSITIVE_INFINITY },
    { columns: "title" },
    { columns: [1] },
    { columns: Array(61).fill("title") },
    { filters: {} },
    { filters: [null] },
    { filters: [{ column: "id", op: "eq" }] },
    { filters: [{ column: 1, op: "eq", value: 1 }] },
    { filters: [{ column: "id", op: "exec", value: 1 }] },
    { filters: [{ column: "id", op: "eq", value: true }] },
    { filters: [{ column: "id", op: "eq", value: {} }] },
    { filters: [{ column: "id", op: "eq", value: Number.NaN }] },
    { filters: [{ column: "id", op: "eq", value: Number.POSITIVE_INFINITY }] },
    { filters: [{ column: "id", op: "eq", value: 1, sql: "1=1" }] },
    { filters: Array(13).fill({ column: "id", op: "eq", value: 1 }) },
  ])
    assert.throws(
      () => normalizeComputerCall({ ...base, ...changes }),
      /computer/,
    );
});

test("computer service accepts typed requests and rejects extra shell or SQL parameters before dispatch", async () => {
  let refreshed = 0;
  const launches: string[] = [];
  const snapshot = { projects: [], workspaces: [] };
  const workspaces = {
    snapshot: () => snapshot,
    refresh: async () => {
      refreshed++;
      return snapshot;
    },
  } as unknown as WorkspaceCatalog;
  const apps = {
    snapshot: () => [],
    open: async (id: string) => {
      launches.push(id);
      return { status: "launch_requested" };
    },
  } as unknown as AppCatalog;
  const service = new ComputerService(workspaces, apps);
  const result = await service.observe(
    normalizeComputerCall(computerCall({ tool: "workspaces" })),
  );
  assert.deepEqual(result, { ...snapshot, roots: [] });
  assert.equal(refreshed, 1);
  assert.deepEqual(
    await service.observe({ tool: "open_app", id: "discovered-id" }),
    { status: "launch_requested" },
  );
  assert.deepEqual(launches, ["discovered-id"]);
  for (const request of [
    { tool: "shell", command: "powershell.exe" },
    { tool: "open_app", id: "discovered-id", command: "powershell.exe" },
    {
      tool: "database_query",
      id: "root",
      path: "data.db",
      sql: "DELETE FROM todos",
    },
    { tool: "open_app", id: "discovered-id", query: "unexpected" },
    { tool: "workspaces", path: "C:/" },
  ])
    await assert.rejects(() => service.observe(request), /不支持/);
  assert.equal(refreshed, 1);
  assert.deepEqual(launches, ["discovered-id"]);
});
