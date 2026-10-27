import type { ReadRequest } from "./reader.js";

export const computerTools = [
  "workspaces",
  "apps",
  "open_app",
  "list_files",
  "read_file",
  "database_schema",
  "database_query",
] as const;
export interface ComputerCall {
  tool: (typeof computerTools)[number];
  id: string | null;
  query: string | null;
  path: string | null;
  offset: number | null;
  table: string | null;
  columns: string[] | null;
  filters: NonNullable<ReadRequest["filters"]> | null;
  limit: number | null;
}
const nullableText = { type: ["string", "null"] };
export const COMPUTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: { type: "string", enum: computerTools },
    id: nullableText,
    query: nullableText,
    path: nullableText,
    table: nullableText,
    offset: { type: ["integer", "null"] },
    limit: { type: ["integer", "null"] },
    columns: { type: ["array", "null"], items: { type: "string" } },
    filters: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          column: { type: "string" },
          op: {
            type: "string",
            enum: ["eq", "ne", "gt", "gte", "lt", "lte", "contains"],
          },
          value: { type: ["string", "number", "null"] },
        },
        required: ["column", "op", "value"],
      },
    },
  },
  required: [
    "tool",
    "id",
    "query",
    "path",
    "table",
    "offset",
    "limit",
    "columns",
    "filters",
  ],
};
export function computerCall(request: ReadRequest): ComputerCall {
  return {
    id: null,
    query: null,
    path: null,
    table: null,
    offset: null,
    limit: null,
    columns: null,
    filters: null,
    ...request,
  } as ComputerCall;
}
export function normalizeComputerCall(value: unknown): ReadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "computer 必须是结构化工具对象，不能是中文描述或 JSON 字符串",
    );
  const p = value as ComputerCall;
  if (
    !computerTools.includes(p.tool) ||
    Object.keys(p).some((key) => !COMPUTER_SCHEMA.required.includes(key)) ||
    COMPUTER_SCHEMA.required.some((key) => !Object.hasOwn(p, key))
  )
    throw new Error("computer 工具字段不符合 schema");
  for (const key of ["id", "query", "path", "table"] as const)
    if (
      p[key] !== null &&
      (typeof p[key] !== "string" || p[key]!.length > 4096)
    )
      throw new Error(`computer.${key} 必须为字符串或 null`);
  if (p.offset !== null && (!Number.isSafeInteger(p.offset) || p.offset < 0))
    throw new Error("computer.offset 无效");
  if (
    p.limit !== null &&
    (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)
  )
    throw new Error("computer.limit 无效");
  if (
    p.columns !== null &&
    (!Array.isArray(p.columns) ||
      p.columns.length > 60 ||
      p.columns.some((c) => typeof c !== "string"))
  )
    throw new Error("computer.columns 无效");
  if (
    p.filters !== null &&
    (!Array.isArray(p.filters) ||
      p.filters.length > 12 ||
      p.filters.some(
        (f) =>
          !f ||
          typeof f.column !== "string" ||
          !["eq", "ne", "gt", "gte", "lt", "lte", "contains"].includes(f.op) ||
          !(
            f.value === null ||
            typeof f.value === "string" ||
            (typeof f.value === "number" && Number.isFinite(f.value))
          ) ||
          Object.keys(f).some((k) => !["column", "op", "value"].includes(k)),
      ))
  )
    throw new Error("computer.filters 无效");
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => v !== null),
  ) as unknown as ReadRequest;
}
