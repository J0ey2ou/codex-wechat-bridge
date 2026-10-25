import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
export interface Config {
  port: number;
  timezone: string;
  dataDir: string;
  codexBin: string;
  codexMode: "real" | "mock";
  wechatMode: "real" | "mock";
  collectionMinutes: number;
  staleMinutes: number;
  timeoutMinutes: number;
  approvalMinutes: number;
  notifyProgress: boolean;
  autoContinueLowRisk: boolean;
}
export function loadConfig(
  file = process.env.BRIDGE_CONFIG || "config.local.json",
): Config {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) : {};
  const c: Config = {
    port: 3210,
    timezone: "Asia/Shanghai",
    dataDir: "./data",
    codexBin: "codex",
    codexMode: "real",
    wechatMode: "real",
    collectionMinutes: 15,
    staleMinutes: 10,
    timeoutMinutes: 120,
    approvalMinutes: 30,
    notifyProgress: true,
    autoContinueLowRisk: false,
    ...raw,
  };
  if (process.env.BRIDGE_DATA_DIR) c.dataDir = process.env.BRIDGE_DATA_DIR;
  if (process.env.BRIDGE_CODEX_BIN) c.codexBin = process.env.BRIDGE_CODEX_BIN;
  if (process.env.BRIDGE_MOCK === "1") c.codexMode = c.wechatMode = "mock";
  if (process.env.BRIDGE_PORT) c.port = Number(process.env.BRIDGE_PORT);
  validateSettings(c);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)
    throw new Error("port 必须是 1024–65535");
  if (
    !["real", "mock"].includes(c.codexMode) ||
    !["real", "mock"].includes(c.wechatMode)
  )
    throw new Error("无效适配器模式");
  c.dataDir = path.resolve(c.dataDir);
  return c;
}
export function validateSettings(c: Partial<Config>): void {
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
  for (const k of ["notifyProgress", "autoContinueLowRisk"] as const)
    if (c[k] !== undefined && typeof c[k] !== "boolean")
      throw new Error(`${k} 必须为布尔值`);
}
