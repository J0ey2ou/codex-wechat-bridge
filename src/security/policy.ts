import path from "node:path";
import { realpathSync, statSync } from "node:fs";
export function canonicalProject(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("项目必须使用绝对路径");
  const p = realpathSync.native(input);
  if (!statSync(p).isDirectory()) throw new Error("项目路径必须是目录");
  if (p === path.parse(p).root) throw new Error("不能授权整个磁盘");
  return p;
}
export function within(root: string, target: string): boolean {
  const r = path.relative(root, target);
  return !r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r);
}
export function safeText(value: unknown, max = 1200): string {
  return String(value ?? "")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|context[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .slice(0, max);
}
export function commandRisk(command: string): string {
  return /remove-item|\brm\b|\bdel\b|format-|diskpart|reg\s|shutdown|curl|invoke-webrequest|set-executionpolicy|git\s+(reset|clean|push)|\bpython\b|\bpowershell\b|\bnode\b/i.test(
    command,
  )
    ? "高风险或任意代码执行；请在本机检查完整操作。"
    : "需要逐次确认；批准仅适用于这一次操作。";
}
