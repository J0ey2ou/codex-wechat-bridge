import type { Project, Task } from "../app/types.js";
import { safeText } from "../security/policy.js";
import { friendlyProblem } from "./presentation.js";
import { presentReply, replyLayout } from "../app/dialogue.js";

const MAX_MESSAGE = 350;
const caveat =
  /尚未|还未|仍未|还没|未(?:能|完成|验证|测试|重启|上线|部署|验收|检查|修复|启动|生效|通过|确认)|没有(?:完成|验证|测试|重启|上线|验收|运行)|无法|失败|未通过|异常|中断|待(?:验证|测试|重启|验收|确认)|需要[^。！？\n]{0,35}(?:重启|验证|验收|手动|确认)|not (?:yet|verified|tested|restarted)|unverified|failed|unable/i;
const failure = /失败|未通过|无法|异常|failed|unable/i;
const metadata =
  /^(?:主要文件|修改文件|文件清单|文件|files?|tests?|测试|验证|耗时|运行时间|状态|status|任务\s*ID|thread(?:Id)?|turn(?:Id)?|process(?:Ids?)?|会话\s*ID|ID)\s*[:：]/i;
const technical =
  /(?:exit[_ ]?code|退出码)\s*[:=：]?\s*-?\d+|^\s*(?:COMPLETED|FAILED|INTERRUPTED|UNKNOWN)\s*$/i;
const caveatKinds = [
  /重启|restart/i,
  /上线|部署|发布|deploy/i,
  /验证|测试|检查|test|verif/i,
  /验收|acceptance/i,
  /额度|配额|token|quota/i,
  /失败|未通过|异常|failed|unable/i,
];

function clip(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}
function plain(
  value: unknown,
  task?: Pick<Task, "id" | "projectId" | "threadId" | "turnId">,
  keepLayout = false,
): string {
  if (typeof value !== "string" || !value.trim()) return "";
  let text = value.trim();
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      text =
        typeof data.userMessage === "string"
          ? data.userMessage
          : typeof data.summary === "string"
            ? data.summary
            : "";
    } catch {
      /* An unstructured result can still contain a useful plain-language summary. */
    }
  }
  text = safeText(text, 100_000).replace(
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,
    "",
  );
  text = text.replace(/!?\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1");
  for (const id of [task?.id, task?.projectId, task?.threadId, task?.turnId])
    if (id) text = text.split(id).join("");
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const marker =
        raw
          .trim()
          .match(
            /^(?:#{1,6}\s+|[-*•]\s+|\d+[.)、]\s+|[（(]\d+[）)]\s*|[一二三四五六七八九十]+[、.)）]\s*)/,
          )?.[0] ?? "";
      let line = raw.trim().slice(marker.length);
      if (!line) return keepLayout ? "" : null;
      if (
        /^(?:内部(?:执行)?说明|完整任务(?:指令|文本)|任务要求|developerInstructions|system prompt|tool call|Traceback|at \S+\s*\(|\{\s*"|(?:npm|npx|pnpm|yarn|node|pytest|tsc|vitest|powershell|dotnet|csc)\s)/i.test(
          line,
        )
      )
        return caveat.test(line)
          ? "有步骤尚未完成，详情已留在软件后台。"
          : null;
      const validation = /^(?:tests?|测试|验证)\s*[:：]/i.test(line);
      const badExit = /(?:exit[_ ]?code|退出码)\s*[:=：]?\s*-?[1-9]\d*/i.test(
        line,
      );
      if (metadata.test(line)) {
        if (!caveat.test(line) && !(validation && badExit)) return null;
        line = line.replace(metadata, "").trim();
      }
      if (
        /^(?:["'`]?)(?:[a-z]:[\\/]|[\\/]|(?:[\w.@-]+[\\/])+)[^\s]*["'`]?[，,;；]?$/i.test(
          line,
        )
      )
        return null;
      if (validation && technical.test(line) && (failure.test(line) || badExit))
        return "有验证未通过。";
      if (
        /\b(?:RPC|Traceback|ENOENT|EACCES|EPERM)\b|\bat \S+\.(?:js|ts):\d+/i.test(
          line,
        )
      )
        return friendlyProblem(line);
      return (
        (keepLayout ? marker : "") +
        line
          .replace(/["'`]([a-z]:[\\/][^"'`\r\n]+)["'`]/gi, "[本地路径]")
          .replace(/(?:[a-z]:[\\/]|\\\\)[^\s"'`<>，。；！？]+/gi, "[本地路径]")
          .replace(/(?:exit[_ ]?code|退出码)\s*[:=：]?\s*-?\d+/gi, "")
          .replace(/\bCOMPLETED\b/g, "处理结束")
          .replace(/\bFAILED\b/g, "未完成")
          .replace(/\bINTERRUPTED\b/g, "已停止")
      );
    })
    .filter((line) => line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}
function importantPart(
  sentence: string,
  limit: number,
  marker = caveat,
): string {
  if (sentence.length <= limit) return sentence;
  const match = sentence.match(marker);
  if (!match || match.index === undefined) return clip(sentence, limit);
  const start = Math.max(0, match.index - 20);
  return (
    (start ? "…" : "") + clip(sentence.slice(start), limit - (start ? 1 : 0))
  );
}
function bounded(text: string, limit: number, marker = caveat): string {
  if (text.length <= limit) return text;
  const parts = sentences(text);
  const cautions = parts
    .filter((part) => marker.test(part))
    .sort((a, b) => Number(failure.test(b)) - Number(failure.test(a)));
  if (!cautions.length) return clip(text, limit);
  const cautionBudget = Math.min(
    limit,
    Math.max(180, Math.floor(limit * 0.65)),
  );
  const selected: string[] = [];
  for (const caution of cautions) {
    const remaining =
      cautionBudget - selected.join("\n").length - (selected.length ? 1 : 0);
    if (remaining < 35) break;
    selected.push(importantPart(caution, Math.min(180, remaining), marker));
  }
  const details = selected.join("\n");
  const main = parts.filter((part) => !marker.test(part)).join(" ");
  const opening = clip(
    main,
    Math.max(0, limit - details.length - (details ? 1 : 0)),
  );
  return [opening, details].filter(Boolean).join("\n");
}

/** Phone-friendly completion text. Technical evidence stays in the task record. */
export function taskCompletionMessage(task: Task, project: Project): string {
  const name =
    safeText(project.name, 60)
      .replace(/[\r\n]+/g, " ")
      .trim() || "这个项目";
  const prefix =
    task.status === "COMPLETED"
      ? `“${name}”：`
      : task.status === "FAILED"
        ? `“${name}”这次没能完成。`
        : task.status === "INTERRUPTED"
          ? `“${name}”已停止，本次任务未完成。`
          : `“${name}”的结果还没有确认。`;
  const withoutPrompt = (value: string | undefined) => {
    let text = value ?? "";
    for (const prompt of [
      task.title,
      ...task.stages.map((stage) => stage.prompt),
    ])
      if (prompt.length > 30) text = text.split(prompt).join("");
    return text;
  };
  const human = plain(withoutPrompt(task.userMessage), task);
  const summary = plain(task.summary, task);
  const incomplete = task.status === "FAILED" || task.status === "INTERRUPTED";
  let text = incomplete
    ? sentences(human || summary)
        .filter((part) => caveat.test(part))
        .join("\n")
    : human || summary;
  if (human && summary) {
    // The friendly text is primary, but a known limitation must not disappear with it.
    const missing = sentences(summary).filter((part) => {
      if (!caveat.test(part) || human.includes(part)) return false;
      const kinds = caveatKinds.filter((kind) => kind.test(part));
      return kinds.length > 0 && !kinds.some((kind) => kind.test(human));
    });
    if (missing.length)
      text +=
        "\n" +
        missing
          .slice(0, 3)
          .map((part) => importantPart(part, 180))
          .join("\n");
  }
  let reason = task.error ? friendlyProblem(task.error) : "";
  if (
    task.status === "INTERRUPTED" &&
    /^(?:用户已中断|用户请求停止|interrupted)$/i.test(task.error ?? "")
  )
    reason = "已按停止请求结束执行。";
  if (!text)
    text = incomplete
      ? "没有收到完整的处理结果。"
      : "没有收到可用的结果说明，具体成果尚无法确认。";
  if (incomplete && !reason)
    reason =
      task.status === "INTERRUPTED"
        ? "执行被中断，尚无进一步原因。"
        : "暂时没有收到具体失败原因。";
  const explanation =
    reason && !text.includes(reason) ? `原因：${clip(reason, 150)}` : "";
  const budget = MAX_MESSAGE - prefix.length - explanation.length - 2;
  return presentReply(
    bounded(
      presentReply(
        [prefix, bounded(text, budget), explanation].filter(Boolean).join("\n"),
      ),
      MAX_MESSAGE,
    ),
  );
}

export function detailsRequested(request: string): boolean {
  return /(?:查看|看看|给我|发我|提供|列出|展示|说明|解释|具体|详细).{0,16}(?:细节|详情|日志|指令|命令|代码|证据|验证|文件|技术|过程)|(?:写|生成).{0,10}(?:代码|函数|脚本)|详细(?:状态|进度)|(?:详情|详细报告|日志|技术细节)[？?。！!\s]*$/.test(
    request.trim(),
  );
}

export function conciseReply(text: string, request: string): string {
  const layout = replyLayout(request);
  if (detailsRequested(request))
    return presentReply(safeText(text, 3500), layout);
  // Explicit structured answers keep their list markers; ordinary answers use one paragraph.
  if (layout === "structured")
    return safeText(plain(text, undefined, true), 3500).trim();
  return (
    presentReply(bounded(presentReply(plain(text)), 360)) ||
    "这次的详细信息已留在软件后台。"
  );
}

/** Compact notification from an observed desktop result; no model call required. */
export function desktopCompletionMessage(
  label: string,
  result: string,
): string {
  const name =
    safeText(label, 60)
      .replace(/[\r\n]+/g, " ")
      .trim() || "桌面会话";
  const prefix = `“${name}”有新结果了。`;
  const needsAction = new RegExp(
    `${caveat.source}|仍需|还需|需要|请(?:先|你|您|在|打开|登录|确认|检查|重启|运行|使用|手动)`,
    "i",
  );
  const command =
    /^(?:npm|npx|pnpm|yarn|node|pytest|tsc|vitest|cargo\s+test|go\s+test|dotnet\s+test)\b/i;
  const text = result
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/!?\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw
        .trim()
        .replace(/^(?:#{1,6}\s+|[-*•]\s+|\d+\.\s+)/, "")
        .replace(/\*\*|__/g, "")
        .replace(/`([^`]+)`/g, "$1");
      if (
        /^(?:主要文件|修改文件|文件清单|文件|files?|tests?|测试(?:结果|情况)?|验证(?:结果|情况)?|耗时|运行时间)\s*[:：]?$/i.test(
          line,
        )
      )
        return "";
      if (
        /^[\w.@-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|css|html|py|ps1|cs|r|sql)(?::\d+)?[。.]?$/i.test(
          line,
        )
      )
        return "";
      if (
        command.test(line) ||
        /(?:exit[_ ]?code|退出码)\s*[:=：]?\s*-?\d+/i.test(line)
      ) {
        const details = line
          .split(/[；;，,]/)
          .filter(
            (part) =>
              needsAction.test(part) &&
              !command.test(part.trim()) &&
              !technical.test(part),
          );
        if (
          (failure.test(line) ||
            /(?:exit[_ ]?code|退出码)\s*[:=：]?\s*-?[1-9]\d*/i.test(line)) &&
          !details.some((part) => failure.test(part))
        )
          details.push("有执行未通过。");
        return details.join("；");
      }
      if (
        /^(?:\d+\s+tests?\s+passed|(?:测试|验证)\s*[:：]?\s*(?:全部)?(?:通过|\d))/i.test(
          line,
        ) &&
        !needsAction.test(line)
      )
        return "";
      return line;
    })
    .filter(Boolean)
    .join("\n");
  const body =
    plain(text)
      .replace(
        /(^|[\s（(：=])["'`]?(?:\/(?:[^\s/"'`<>，。；！？]+\/)*[^\s"'`<>，。；！？]+)["'`]?/gm,
        "$1[本地路径]",
      )
      .trim() || "没有收到可用的结果说明，具体成果尚无法确认。";
  return presentReply(
    bounded(
      presentReply(
        `${prefix}\n${bounded(body, MAX_MESSAGE - prefix.length - 1, needsAction)}`,
      ),
      MAX_MESSAGE,
      needsAction,
    ),
  );
}
