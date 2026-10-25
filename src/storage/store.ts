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
] as const;
export type Table = (typeof tables)[number];
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
    });
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
    return r ? (JSON.parse(String(r.data)) as T) : undefined;
  }
  all<T>(table: Table): T[] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY updated_at DESC`)
      .all()
      .map((r) => JSON.parse(String(r.data)) as T);
  }
  put<T extends { id: string }>(table: Table, value: T): void {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      )
      .run(value.id, JSON.stringify(value), Date.now());
  }
  insert<T extends { id: string }>(table: Table, value: T): boolean {
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
