import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export interface Config {
  port: number;
  timezone: string;
  dataDir: string;
  projectCreationRoot: string;
  codexBin: string;
  codexMode: "real" | "mock";
  codexTransport: "default" | "chatgpt-http";
  wechatMode: "real" | "mock";
  collectionMinutes: number;
  staleMinutes: number;
  timeoutMinutes: number;
  approvalMinutes: number;
  notifyProgress: boolean;
  wechatPushEnabled: boolean;
  autoContinueLowRisk: boolean;
  executionAuthorization: "bound-user" | "per-action";
}
export function loadConfig(
  file = process.env.BRIDGE_CONFIG || "config.local.json",
): Config {
  const raw = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const c: Config = {
    port: 3210,
    timezone: "Asia/Shanghai",
    dataDir: "./data",
    projectCreationRoot: "./projects",
    codexBin: "codex",
    codexMode: "real",
    codexTransport: "default",
    wechatMode: "real",
    collectionMinutes: 15,
    staleMinutes: 10,
    timeoutMinutes: 120,
    approvalMinutes: 30,
    notifyProgress: true,
    wechatPushEnabled: true,
    autoContinueLowRisk: false,
    executionAuthorization: "bound-user",
    ...raw,
  };
  if (process.env.BRIDGE_DATA_DIR) c.dataDir = process.env.BRIDGE_DATA_DIR;
  if (process.env.BRIDGE_CODEX_BIN) c.codexBin = process.env.BRIDGE_CODEX_BIN;
  if (process.env.BRIDGE_MOCK === "1") c.codexMode = c.wechatMode = "mock";
  if (process.env.BRIDGE_PORT) c.port = Number(process.env.BRIDGE_PORT);
  validateSettings(c);
  if (!["default", "chatgpt-http"].includes(c.codexTransport))
    throw new Error("无效 Codex 传输方式");
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)
    throw new Error("port 必须是 1024–65535");
  if (
    !["real", "mock"].includes(c.codexMode) ||
    !["real", "mock"].includes(c.wechatMode)
  )
    throw new Error("无效适配器模式");
  c.dataDir = path.resolve(c.dataDir);
  if (
    typeof c.projectCreationRoot !== "string" ||
    !c.projectCreationRoot.trim()
  )
    throw new Error("projectCreationRoot 必须为项目创建目录");
  c.projectCreationRoot = path.resolve(c.projectCreationRoot);
  const creationRelative = path.relative(process.cwd(), c.projectCreationRoot);
  if (
    !creationRelative ||
    creationRelative === ".." ||
    creationRelative.startsWith(".." + path.sep) ||
    path.isAbsolute(creationRelative)
  )
    throw new Error(
      "projectCreationRoot 必须位于当前 Bridge 工作目录内的独立子目录",
    );
  return c;
}
export function validateSettings(c: Partial<Config>): void {
  if (
    c.executionAuthorization !== undefined &&
    !["bound-user", "per-action"].includes(c.executionAuthorization)
  )
    throw new Error("无效任务执行授权方式");
  if (c.timezone !== undefined)
    new Intl.DateTimeFormat("zh-CN", { timeZone: c.timezone }).format();
  for (const k of [
    "collectionMinutes",
    "staleMinutes",
    "timeoutMinutes",
    "approvalMinutes",
  ] as const) {
    const v = c[k];
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 10080))
      throw new Error(`${k} 范围为 0–10080`);
  }
  for (const k of [
    "notifyProgress",
    "autoContinueLowRisk",
    "wechatPushEnabled",
  ] as const)
    if (c[k] !== undefined && typeof c[k] !== "boolean")
      throw new Error(`${k} 必须为布尔值`);
}
