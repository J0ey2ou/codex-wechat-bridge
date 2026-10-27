import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { LocalReader, type ReadRequest } from "../src/computer/reader.js";

function fixture(t: TestContext) {
  const parent = realpathSync.native(os.tmpdir());
  const directory = mkdtempSync(path.join(parent, "codex-wechat-reader-"));
  const root = path.join(directory, "app");
  const outside = path.join(directory, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const reader = new LocalReader(() => [
    { id: "app-root", name: "测试应用", path: root },
  ]);
  t.after(() => {
    // Only remove this fixture's own temporary directory, never an inferred path.
    const resolved = realpathSync.native(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("codex-wechat-reader-"));
    rmSync(resolved, { recursive: true, force: true });
  });
  function read(request: Omit<ReadRequest, "id"> & { id?: string }): any {
    return reader.read({ id: "app-root", ...request });
  }
  function database() {
    const file = path.join(root, "tasks.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, due_date TEXT, done INTEGER, note TEXT);
      INSERT INTO tasks VALUES
        (1, '交报告', '2026-10-26', 0, NULL),
        (2, '开周会', '2026-10-26', 1, '会议室 A'),
        (3, '整理资料', '2026-10-27', 0, NULL),
        (4, 'literal %_\\ text', '2026-10-28', 0, '特殊字符');
    `);
    db.close();
    return file;
  }
  return { root, outside, reader, read, database };
}

test("local reader lists and reads actual files with source evidence", (t) => {
  const { root, read } = fixture(t);
  mkdirSync(path.join(root, "notes"));
  writeFileSync(
    path.join(root, "notes", "today.md"),
    "今日待办：交报告。",
    "utf8",
  );
  const listing = read({ tool: "list_files" });
  assert.equal(listing.source, "测试应用");
  assert.equal(listing.path, realpathSync.native(root));
  assert.ok(Number.isFinite(Date.parse(listing.observedAt)));
  assert.equal(listing.truncated, false);
  assert.deepEqual(
    listing.entries.map((e: any) => [e.name, e.type]),
    [["notes", "directory"]],
  );
  const result = read({ tool: "read_file", path: "notes/today.md" });
  assert.equal(result.text, "今日待办：交报告。");
  assert.equal(
    result.path,
    realpathSync.native(path.join(root, "notes", "today.md")),
  );
  assert.equal(result.modifiedAt, statSync(result.path).mtime.toISOString());
  assert.equal(result.nextOffset, null);
});

test("text and database observations redact quoted credential fields before model access", (t) => {
  const { root, read } = fixture(t);
  writeFileSync(
    path.join(root, "settings.json"),
    JSON.stringify({
      title: "报告",
      access_token: "example-secret",
      password: "example password with spaces",
      nested: { client_secret: "secret-nested" },
    }),
  );
  const text = read({ tool: "read_file", path: "settings.json" }).text;
  assert.match(text, /报告/);
  for (const secret of ["example-secret", "example password", "secret-nested"])
    assert.equal(text.includes(secret), false);
  const db = new DatabaseSync(path.join(root, "business.db"));
  db.exec(
    "CREATE TABLE users(name TEXT, password_hash TEXT, access_token TEXT); INSERT INTO users VALUES('owner','secret-hash','secret-token');",
  );
  db.close();
  const result = read({
    tool: "database_query",
    path: "business.db",
    table: "users",
  });
  assert.equal(result.rows[0].name, "owner");
  assert.equal(result.rows[0].password_hash, "[REDACTED]");
  assert.equal(result.rows[0].access_token, "[REDACTED]");
});

test("local reader bounds file content and directory entries and supports continuation", (t) => {
  const { root, read } = fixture(t);
  writeFileSync(path.join(root, "large.txt"), "a".repeat(20000));
  for (let i = 0; i < 151; i++)
    writeFileSync(path.join(root, `entry-${i}.txt`), "");
  const listing = read({ tool: "list_files" });
  assert.equal(listing.entries.length, 150);
  assert.equal(listing.truncated, true);
  const first = read({ tool: "read_file", path: "large.txt" });
  assert.equal(first.text.length, 18000);
  assert.equal(first.nextOffset, 18000);
  const second = read({
    tool: "read_file",
    path: "large.txt",
    offset: first.nextOffset,
  });
  assert.equal(second.text, "a".repeat(2000));
  assert.equal(second.nextOffset, null);
  for (const offset of [-1, 0.5, 20001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => read({ tool: "read_file", path: "large.txt", offset }),
      /偏移/,
    );
  }
});

test("SQLite reader discovers the real schema and applies structured filters without changing data", (t) => {
  const { read, database } = fixture(t);
  const file = database();
  const before = readFileSync(file);
  const beforeModified = statSync(file).mtimeMs;
  const schema = read({ tool: "database_schema", path: "tasks.sqlite" });
  assert.equal(schema.path, realpathSync.native(file));
  assert.equal(schema.tables.length, 1);
  assert.equal(schema.tables[0].name, "tasks");
  assert.deepEqual(schema.tables[0].columns[0], {
    name: "id",
    type: "INTEGER",
    primaryKey: true,
  });
  const result = read({
    tool: "database_query",
    path: "tasks.sqlite",
    table: "tasks",
    columns: ["id", "title"],
    filters: [
      { column: "due_date", op: "eq", value: "2026-10-26" },
      { column: "done", op: "eq", value: 0 },
    ],
  });
  assert.deepEqual(result.rows, [{ id: "1", title: "交报告" }]);
  assert.equal(result.truncated, false);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).mtimeMs, beforeModified);
});

test("SQLite reader treats null and LIKE wildcard characters as literal filter values", (t) => {
  const { read, database } = fixture(t);
  database();
  const query = (filters: ReadRequest["filters"]) =>
    read({
      tool: "database_query",
      path: "tasks.sqlite",
      table: "tasks",
      columns: ["id"],
      filters,
    }).rows;
  assert.deepEqual(query([{ column: "note", op: "eq", value: null }]), [
    { id: "1" },
    { id: "3" },
  ]);
  assert.deepEqual(query([{ column: "note", op: "ne", value: null }]), [
    { id: "2" },
    { id: "4" },
  ]);
  assert.deepEqual(
    query([{ column: "title", op: "contains", value: "%_\\" }]),
    [{ id: "4" }],
  );
  assert.deepEqual(
    query([{ column: "title", op: "eq", value: "' OR 1=1 --" }]),
    [],
  );
  assert.throws(
    () => query([{ column: "note", op: "gt", value: null }]),
    /空值/,
  );
});

test("SQLite reader rejects SQL, invented tables, columns, operators and unsupported tools", (t) => {
  const { read, database } = fixture(t);
  const file = database();
  const before = readFileSync(file);
  const base = { tool: "database_query", path: "tasks.sqlite", table: "tasks" };
  for (const table of [
    "missing",
    "tasks; DROP TABLE tasks; --",
    "sqlite_master",
    "(SELECT * FROM tasks)",
  ]) {
    assert.throws(() => read({ ...base, table }), /数据表/);
  }
  for (const columns of [
    [],
    ["missing"],
    ["title; DROP TABLE tasks; --"],
    ["*"],
    ["count(*)"],
  ]) {
    assert.throws(() => read({ ...base, columns }), /字段/);
  }
  assert.throws(
    () =>
      read({ ...base, filters: [{ column: "missing", op: "eq", value: 1 }] }),
    /过滤/,
  );
  assert.throws(
    () =>
      read({ ...base, filters: [{ column: "id", op: "= 1 OR 1=", value: 1 }] }),
    /过滤/,
  );
  assert.throws(
    () => read({ tool: "execute_sql", path: "tasks.sqlite" }),
    /不支持/,
  );
  // An unexpected raw SQL property cannot become executable SQL.
  read({ ...base, sql: "DROP TABLE tasks" } as ReadRequest);
  assert.deepEqual(readFileSync(file), before);
});

test("SQLite reader validates filter types and finite numbers before querying", (t) => {
  const { read, database } = fixture(t);
  database();
  for (const value of [
    true,
    false,
    undefined,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(
      () =>
        read({
          tool: "database_query",
          path: "tasks.sqlite",
          table: "tasks",
          filters: [
            { column: "id", op: "eq", value },
          ] as ReadRequest["filters"],
        }),
      /过滤/,
      `invalid filter value: ${String(value)}`,
    );
  }
});

test("SQLite reader truncates rows and rejects an unbounded query limit", (t) => {
  const { read, database } = fixture(t);
  database();
  const base = { tool: "database_query", path: "tasks.sqlite", table: "tasks" };
  const result = read({ ...base, limit: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.limit, 2);
  assert.equal(read({ ...base, limit: 4 }).truncated, false);
  for (const limit of [0, -1, 101, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => read({ ...base, limit }), /1–100/);
  }
});

test("SQLite reader excludes virtual tables, their shadow tables and views", (t) => {
  const { root, read, database } = fixture(t);
  database();
  const db = new DatabaseSync(path.join(root, "tasks.sqlite"));
  let shadowTables: string[];
  try {
    db.exec(
      "CREATE VIRTUAL TABLE search_index USING fts5(body); CREATE VIEW task_view AS SELECT * FROM tasks;",
    );
    shadowTables = db
      .prepare("PRAGMA table_list")
      .all()
      .filter((row) => row.type === "shadow")
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
  assert.ok(
    shadowTables.length > 0,
    "fixture creates actual FTS shadow tables",
  );
  const schema = read({ tool: "database_schema", path: "tasks.sqlite" });
  assert.deepEqual(
    schema.tables.map((table: any) => table.name),
    ["tasks"],
  );
  for (const table of ["search_index", "task_view", ...shadowTables]) {
    assert.throws(
      () => read({ tool: "database_query", path: "tasks.sqlite", table }),
      /数据表/,
    );
  }
});

test("local reader blocks unrecognized roots, absolute paths, traversal and external junctions", (t) => {
  const { root, outside, read } = fixture(t);
  writeFileSync(path.join(outside, "external.txt"), "outside data");
  symlinkSync(
    outside,
    path.join(root, "external-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => read({ tool: "list_files", id: "invented" }), /目录/);
  assert.throws(
    () => read({ tool: "read_file", path: path.join(outside, "external.txt") }),
    /相对路径/,
  );
  assert.throws(
    () => read({ tool: "read_file", path: "../outside/external.txt" }),
    /超出/,
  );
  assert.throws(
    () => read({ tool: "read_file", path: "external-link/external.txt" }),
    /超出/,
  );
  assert.throws(
    () => read({ tool: "read_file", path: "external.txt:alternate" }),
    /相对路径/,
  );
  const entry = read({ tool: "list_files" }).entries.find(
    (item: any) => item.name === "external-link",
  );
  assert.deepEqual(entry, { name: "external-link", accessible: false });
});

test("local reader blocks credential files and directory link aliases", (t) => {
  const { root, read } = fixture(t);
  for (const name of [
    ".env",
    ".env.local",
    "auth.json",
    "credentials",
    "private.pem",
    "login data",
    "cookies",
  ]) {
    writeFileSync(path.join(root, name), "secret value");
    assert.throws(() => read({ tool: "read_file", path: name }), /凭据/);
  }
  mkdirSync(path.join(root, ".codex"));
  writeFileSync(
    path.join(root, ".codex", "settings.json"),
    '{"secret":"hidden"}',
  );
  symlinkSync(
    path.join(root, ".codex"),
    path.join(root, "friendly-alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => read({ tool: "read_file", path: "friendly-alias/settings.json" }),
    /凭据/,
  );
  assert.throws(
    () => read({ tool: "list_files", path: "friendly-alias" }),
    /凭据/,
  );
  const listing = read({ tool: "list_files" });
  assert.ok(listing.entries.every((entry: any) => entry.accessible === false));
});

test("local reader refuses a discovered root inside a credential directory, including root aliases", (t) => {
  const { root } = fixture(t);
  const privateRoot = path.join(root, ".codex", "nested");
  mkdirSync(privateRoot, { recursive: true });
  writeFileSync(path.join(privateRoot, "ordinary.json"), '{"value":"private"}');
  const alias = path.join(root, "ordinary-directory");
  symlinkSync(
    privateRoot,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const location of [privateRoot, alias]) {
    const reader = new LocalReader(() => [
      { id: "private-root", name: "发现的目录", path: location },
    ]);
    assert.throws(
      () => reader.read({ tool: "list_files", id: "private-root" }),
      /凭据/,
    );
    assert.throws(
      () =>
        reader.read({
          tool: "read_file",
          id: "private-root",
          path: "ordinary.json",
        }),
      /凭据/,
    );
  }
});

test("local reader refuses hard-link aliases of credential files", (t) => {
  const { root, read } = fixture(t);
  const credential = path.join(root, "auth.json");
  const alias = path.join(root, "ordinary.json");
  writeFileSync(credential, '{"secret":"hidden"}');
  linkSync(credential, alias);
  assert.equal(statSync(alias).nlink, 2);
  assert.throws(
    () => read({ tool: "read_file", path: "ordinary.json" }),
    /硬链接/,
  );
});

test("local reader reports unsupported formats, binary text and missing files honestly", (t) => {
  const { root, read } = fixture(t);
  writeFileSync(path.join(root, "report.pdf"), "not a text document");
  writeFileSync(path.join(root, "binary.txt"), Buffer.from([65, 0, 66]));
  writeFileSync(path.join(root, "fake.db"), "not a SQLite database");
  assert.throws(
    () => read({ tool: "read_file", path: "report.pdf" }),
    /不支持/,
  );
  assert.throws(() => read({ tool: "read_file", path: "binary.txt" }), /UTF-8/);
  assert.throws(
    () => read({ tool: "read_file", path: "missing.txt" }),
    /ENOENT/,
  );
  assert.throws(
    () => read({ tool: "database_schema", path: "report.pdf" }),
    /SQLite/,
  );
  assert.throws(
    () => read({ tool: "database_schema", path: "fake.db" }),
    /database/,
  );
});
