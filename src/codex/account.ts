import type { CodexController } from "../app/types.js";

export async function answerAccount(
  codex: CodexController,
  text: string,
  timezone: string,
): Promise<string> {
  const account = await codex.request("account/read", { refreshToken: false });
  if (account.account?.type === "apiKey")
    return "当前使用 OpenAI Platform API 计费，不使用 ChatGPT 套餐额度。此 Bridge 未接入组织 Usage / Costs API；请在 Platform 用量页核实，不能据此推算余额。";
  const used =
    /用了|使用了|用掉|累计|消耗/.test(text) && !/还剩|剩余|还有/.test(text);
  if (used) {
    const data = await codex.request("account/usage/read");
    const n = data.summary?.lifetimeTokens;
    return typeof n === "number" && Number.isFinite(n)
      ? `官方用量统计显示，你累计使用了 ${n.toLocaleString("zh-CN")} token。这是已用量，不是剩余额度。`
      : "官方接口暂未提供你的累计 token 用量，不能据此判断剩余多少。";
  }
  const data = await codex.request("account/rateLimits/read");
  const mapped = Object.entries(data.rateLimitsByLimitId ?? {});
  const buckets: [string, any][] = mapped.length
    ? mapped
    : [["Codex", data.rateLimits ?? {}]];
  const lines: string[] = [];
  for (const [id, bucket] of buckets) {
    for (const [key, label] of [
      ["primary", "主要额度"],
      ["secondary", "另一额度窗口"],
    ]) {
      const w = bucket[key!];
      if (
        !w ||
        typeof w.usedPercent !== "number" ||
        !Number.isFinite(w.usedPercent)
      )
        continue;
      const mins = w.windowDurationMins;
      const window =
        typeof mins === "number" && mins > 0
          ? mins % 1440 === 0
            ? `${mins / 1440} 天`
            : mins % 60 === 0
              ? `${mins / 60} 小时`
              : `${mins} 分钟`
          : label;
      const reset =
        typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)
          ? `；重置时间 ${new Date(w.resetsAt * 1000).toLocaleString("zh-CN", { timeZone: timezone, hour12: false })}`
          : "";
      lines.push(
        `${bucket.limitName ?? id} · ${window}：剩余约 ${Math.max(0, Math.min(100, 100 - w.usedPercent))}%${reset}。`,
      );
    }
  }
  const permission =
    data.ordinaryUsageAllowed === false
      ? "\n官方当前报告：套餐内使用暂不可用。"
      : "";
  return `当前账号接口不提供“还剩多少个 token”的精确余额。${lines.length ? "查到的额度如下：\n" + lines.join("\n") : "这次也没有返回可显示的额度比例。"}${permission}`;
}
