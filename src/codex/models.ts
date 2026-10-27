import type { CodexController } from "../app/types.js";

export function modelIdentifier(request: string): string {
  const value = request.trim().toLowerCase();
  if (/^(?:gpt[- ]?)?6\.1[- ]?sol$/.test(value)) return "gpt-6.1-sol";
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value))
    throw new Error(
      "请提供明确的模型标识，例如 6.1sol；不会自动换用其他模型。",
    );
  return value;
}

/** Catalog support is not proof of account entitlement or completed inference. */
export async function requireModel(
  codex: Pick<CodexController, "request">,
  request: string,
) {
  const model = modelIdentifier(request);
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const r = await codex.request<{
      data?: { model?: string; hidden?: boolean }[];
      nextCursor?: unknown;
    }>("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(r?.data))
      throw new Error("执行端未提供有效模型目录，未选择替代模型。");
    if (r.data.some((entry) => entry?.model === model && entry.hidden !== true))
      return model;
    if (r.nextCursor == null || r.nextCursor === "")
      throw new Error(`执行端当前未列出 ${model}，未选择替代模型。`);
    if (typeof r.nextCursor !== "string" || cursors.has(r.nextCursor)) break;
    cursor = r.nextCursor;
    cursors.add(cursor);
  }
  throw new Error(
    "执行端模型目录未完整返回，无法核实指定模型；未换用其他模型。",
  );
}

export function verifyThreadModel(
  response: { model?: unknown },
  requested: string,
) {
  if (response.model !== requested)
    throw new Error(
      `执行端未确认指定模型 ${requested}（返回 ${typeof response.model === "string" ? response.model : "未报告"}），未启动任务轮次。`,
    );
}
