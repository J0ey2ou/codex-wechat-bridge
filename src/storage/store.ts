import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
export const tables = [
  "projects",
  "codex_sessions",
  "tasks",
  "task_events",
  "approvals",
  "messages",
  "todos",
  "reminders",
  "notification_deliveries",
  "application_settings",
  "questions",
  "user_profiles",
  "user_memories",
  "inference_records",
  "project_creations",
  "routing_requests",
  "pdf_reports",
] as const;
export type Table = (typeof tables)[number];
// One bound user at a time. Business context must never follow a rebind.
const ownedTables = new Set<Table>([
  "projects",
  "tasks",
  "task_events",
  "approvals",
  "todos",
  "reminders",
  "codex_sessions",
  "user_profiles",
  "user_memories",
  "inference_records",
  "project_creations",
  "routing_requests",
  "pdf_reports",
]);
export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    this.migrate();
  }
  private migrate() {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    this.transaction(() => {
      if (
        !this.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=1")
          .get()
      ) {
        for (const t of tables)
          this.db.exec(
            `CREATE TABLE ${t}(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), updated_at INTEGER NOT NULL)`,
          );
        this.db.exec(
          "CREATE UNIQUE INDEX delivery_dedupe ON notification_deliveries(json_extract(data,'$.dedupeKey')); CREATE UNIQUE INDEX todo_dedupe ON todos(json_extract(data,'$.dedupeKey')); CREATE INDEX task_status ON tasks(json_extract(data,'$.status')); CREATE INDEX reminder_due ON reminders(json_extract(data,'$.dueAt'));",
        );
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(1,?)")
          .run(Date.now());
      }
      if (
        !this.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=2")
          .get()
      ) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), updated_at INTEGER NOT NULL)",
        );
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(2,?)")
          .run(Date.now());
      }
      if (
        !this.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=3")
          .get()
      ) {
        for (const t of ["user_profiles", "user_memories", "inference_records"])
          this.db.exec(
            `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), updated_at INTEGER NOT NULL)`,
          );
        const owner = this.owner();
        for (const t of [...ownedTables].filter(
          (t) =>
            !["project_creations", "routing_requests", "pdf_reports"].includes(
              t,
            ),
        ))
          this.db
            .prepare(
              `UPDATE ${t} SET data=json_set(data,'$.ownerId',?) WHERE json_extract(data,'$.ownerId') IS NULL`,
            )
            .run(owner);
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(3,?)")
          .run(Date.now());
      }
      if (
        !this.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=4")
          .get()
      ) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS project_creations(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), updated_at INTEGER NOT NULL)",
        );
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(4,?)")
          .run(Date.now());
      }
      if (
        !this.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=5")
          .get()
      ) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS routing_requests(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), updated_at INTEGER NOT NULL)",
        );
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(5,?)")
          .run(Date.now());
      }
      if (
        !this.db
          .prepare("SELECT 1 FROM schema_migrations WHERE version=6")
          .get()
      ) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS pdf_reports(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), updated_at INTEGER NOT NULL)",
        );
        this.db
          .prepare("INSERT INTO schema_migrations VALUES(6,?)")
          .run(Date.now());
      }
    });
  }
  private owner(): string {
    const row = this.db
      .prepare("SELECT data FROM application_settings WHERE id='boundUser'")
      .get();
    return (row && JSON.parse(String(row.data)).value) || "__local__";
  }
  private visible(table: Table, value: any): boolean {
    return !ownedTables.has(table) || value.ownerId === this.owner();
  }
  // Ownership check without exposing another user's record to callers.
  isForeign(table: Table, id: string): boolean {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return !!row && !this.visible(table, JSON.parse(String(row.data)));
  }
  private owned<T extends { id: string }>(table: Table, value: T): T {
    if (!ownedTables.has(table)) return value;
    const previous = this.db
      .prepare(`SELECT data FROM ${table} WHERE id=?`)
      .get(value.id);
    if (previous && !this.visible(table, JSON.parse(String(previous.data))))
      throw new Error("记录不属于当前用户");
    return { ...value, ownerId: this.owner() };
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get<T>(table: Table, id: string): T | undefined {
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    const value = r ? JSON.parse(String(r.data)) : undefined;
    return value && this.visible(table, value) ? (value as T) : undefined;
  }
  all<T>(table: Table): T[] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY updated_at DESC`)
      .all()
      .map((r) => JSON.parse(String(r.data)))
      .filter((value) => this.visible(table, value)) as T[];
  }
  put<T extends { id: string }>(table: Table, value: T): void {
    value = this.owned(table, value);
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      )
      .run(value.id, JSON.stringify(value), Date.now());
  }
  insert<T extends { id: string }>(table: Table, value: T): boolean {
    value = this.owned(table, value);
    return (
      Number(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO ${table}(id,data,updated_at) VALUES(?,?,?)`,
          )
          .run(value.id, JSON.stringify(value), Date.now()).changes,
      ) > 0
    );
  }
  delete(table: Table, id: string) {
    if (ownedTables.has(table) && !this.get(table, id)) return;
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  setting<T>(id: string, fallback: T): T {
    return (
      this.get<{ id: string; value: T }>("application_settings", id)?.value ??
      fallback
    );
  }
  setSetting(id: string, value: unknown) {
    this.put("application_settings", { id, value });
  }
  close() {
    this.db.close();
  }
}
