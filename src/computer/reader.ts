import path from "node:path";
import {
  openSync,
  closeSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { within, safeText, sensitiveKey } from "../security/policy.js";

export interface ReadRoot {
  id: string;
  name: string;
  path: string;
}
export interface ReadRequest {
  tool: string;
  id?: string;
  query?: string;
  path?: string;
  offset?: number;
  table?: string;
  columns?: string[];
  filters?: { column: string; op: string; value: string | number | null }[];
  limit?: number;
}

// These are data readers, not a shell. All locations must originate in local discovery.
const privatePart =
  /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.git|secrets?|credentials?|auth\.json|login data|cookies|key[34]\.db|logins\.json|.*\.(?:pem|pfx|p12|key))$/i;
export class LocalReader {
  constructor(private roots: () => ReadRoot[]) {}
  resolve(id: string, relative = "") {
    const root = this.roots().find((r) => r.id === id);
    if (!root) throw new Error("没有找到这个已发现的目录，请重新发现后选择");
    if (path.isAbsolute(relative) || relative.includes(":"))
      throw new Error("请使用目录内的相对路径");
    if (relative.split(/[\\/]/).some((p) => privatePart.test(p)))
      throw new Error("不读取凭据或安全配置文件");
    const base = realpathSync.native(root.path);
    const target = realpathSync.native(path.resolve(base, relative));
    if (
      [base, target].some((location) =>
        location.split(/[\\/]/).some((p) => privatePart.test(p)),
      )
    )
      throw new Error("不读取凭据或安全配置文件");
    if (!within(base, target))
      throw new Error("路径超出了发现目录，不能通过链接访问其他位置");
    if (
      path
        .relative(base, target)
        .split(/[\\/]/)
        .some((p) => privatePart.test(p))
    )
      throw new Error("不读取凭据或安全配置文件");
    return { root, target };
  }
  read(request: ReadRequest): unknown {
    if (
      typeof request.id !== "string" ||
      (request.path !== undefined && typeof request.path !== "string")
    )
      throw new Error("读取需要真实目录 ID 与相对路径");
    const { root, target } = this.resolve(request.id, request.path);
    const stat = statSync(target);
    const evidence = {
      source: root.name,
      path: target,
      observedAt: new Date().toISOString(),
      modifiedAt: stat.mtime.toISOString(),
    };
    if (request.tool === "list_files") {
      if (!stat.isDirectory()) throw new Error("这不是目录");
      const items = readdirSync(target, { withFileTypes: true });
      return {
        ...evidence,
        entries: items.slice(0, 150).map((entry) => {
          const rel = path.relative(root.path, path.join(target, entry.name));
          try {
            const resolved = this.resolve(root.id, rel);
            const s = statSync(resolved.target);
            return {
              name: entry.name,
              path: rel,
              type: s.isDirectory() ? "directory" : "file",
              size: s.size,
              modifiedAt: s.mtime.toISOString(),
            };
          } catch {
            return { name: entry.name, accessible: false };
          }
        }),
        truncated: items.length > 150,
      };
    }
    if (!stat.isFile()) throw new Error("这不是文件");
    if (stat.nlink > 1)
      throw new Error("不通过硬链接读取文件，请选择实际数据文件");
    if (request.tool === "read_file") {
      if (
        !/\.(?:txt|md|json|jsonl|csv|tsv|log|yaml|yml|toml|ini|cfg|xml|html|htm|py|js|mjs|cjs|ts|tsx|jsx|sql|spec)$/i.test(
          target,
        )
      )
        throw new Error(
          "当前文本读取器不支持这种文件；SQLite 请使用数据库工具",
        );
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size)
        throw new Error("文本偏移无效");
      const buffer = Buffer.alloc(Math.min(18000, stat.size - offset));
      const fd = openSync(target, "r");
      let length: number;
      try {
        length = readSync(fd, buffer, 0, buffer.length, offset);
      } finally {
        closeSync(fd);
      }
      if (buffer.includes(0)) throw new Error("文件看起来不是 UTF-8 文本");
      return {
        ...evidence,
        text: safeText(buffer.subarray(0, length).toString("utf8"), 18000),
        nextOffset: offset + length < stat.size ? offset + length : null,
      };
    }
    if (!["database_schema", "database_query"].includes(request.tool))
      throw new Error("不支持的只读工具");
    if (!/\.(?:sqlite3?|db|db3)$/i.test(target))
      throw new Error("请选择 SQLite 数据文件");
    const db = new DatabaseSync(target, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      db.exec(
        "PRAGMA query_only=ON; PRAGMA busy_timeout=1500; PRAGMA trusted_schema=OFF;",
      );
      const tables = db
        .prepare("PRAGMA table_list")
        .all()
        .filter(
          (t) =>
            t.schema === "main" &&
            t.type === "table" &&
            !String(t.name).startsWith("sqlite_"),
        )
        .slice(0, 100)
        .map((t) => String(t.name));
      const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
      const columns = (table: string) =>
        db
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((c) => ({
            name: String(c.name),
            type: String(c.type),
            primaryKey: Boolean(c.pk),
          }));
      if (request.tool === "database_schema")
        return {
          ...evidence,
          tables: tables.map((name) => ({ name, columns: columns(name) })),
        };
      if (!request.table || !tables.includes(request.table))
        throw new Error("请选择 schema 中真实存在的数据表");
      const validColumns = columns(request.table).map((c) => c.name);
      const selected = request.columns ?? validColumns;
      if (
        !Array.isArray(selected) ||
        !selected.length ||
        selected.length > 60 ||
        selected.some((c) => !validColumns.includes(c))
      )
        throw new Error("查询字段不在表结构中");
      const filters = request.filters ?? [];
      if (!Array.isArray(filters) || filters.length > 12)
        throw new Error("过滤条件无效");
      const ops: Record<string, string> = {
        eq: "=",
        ne: "!=",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
        contains: "LIKE",
      };
      const values: (string | number | null)[] = [];
      const clauses = filters.map((f) => {
        if (
          !f ||
          !validColumns.includes(f.column) ||
          !Object.hasOwn(ops, f.op) ||
          !["string", "number", "object"].includes(typeof f.value) ||
          (typeof f.value === "object" && f.value !== null) ||
          (typeof f.value === "number" && !Number.isFinite(f.value))
        )
          throw new Error("过滤字段或条件无效");
        if (f.value === null) {
          if (!["eq", "ne"].includes(f.op)) throw new Error("空值只支持 eq/ne");
          return `${quote(f.column)} IS ${f.op === "ne" ? "NOT " : ""}NULL`;
        }
        values.push(
          f.op === "contains"
            ? `%${String(f.value).replace(/[\\%_]/g, "\\$&")}%`
            : f.value,
        );
        return `${quote(f.column)} ${ops[f.op]} ?${f.op === "contains" ? " ESCAPE '\\'" : ""}`;
      });
      const limit = request.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("每次查询限 1–100 行");
      const stmt = db.prepare(
        `SELECT ${selected.map(quote).join(",")} FROM ${quote(request.table)}${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} LIMIT ?`,
      );
      stmt.setReadBigInts(true);
      const rows = stmt.all(...values, limit + 1);
      return {
        ...evidence,
        table: request.table,
        filters,
        rows: rows
          .slice(0, limit)
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                sensitiveKey(k)
                  ? "[REDACTED]"
                  : typeof v === "bigint"
                    ? v.toString()
                    : typeof v === "string"
                      ? safeText(v, 1500)
                      : v instanceof Uint8Array
                        ? "[binary]"
                        : v,
              ]),
            ),
          ),
        truncated: rows.length > limit,
        limit,
      };
    } finally {
      db.close();
    }
  }
}
