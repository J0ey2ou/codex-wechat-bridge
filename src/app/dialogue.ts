/** Presentation only: never chooses a tool, changes permissions, or calls a model. */
export type ReplyLayout = "paragraph" | "structured";
export const DIALOGUE_REVISION = "2026-10-26-layered-v2";
export function effectiveVoice(preferences: {
  enabled?: boolean;
  tone?: string;
  detail?: string;
}) {
  const tone =
    preferences.enabled === false ? "natural" : (preferences.tone ?? "natural");
  const detail =
    preferences.enabled === false
      ? "adaptive"
      : (preferences.detail ?? "adaptive");
  return {
    revision: DIALOGUE_REVISION,
    tone,
    detail,
    identity: "AI",
    delivery: "single-message",
    extraModelCalls: 0,
    guidance: `${tone === "warm" ? "说话温和，关注用户眼前的感受；不编造自己的感情。" : tone === "direct" ? "直接给重点，省掉寒暄和重复解释。" : "像熟悉的搭档一样自然接话，放松、平实，不端着。"}${detail === "detailed" ? "需要细节时讲清楚，日常接话仍保持短句。" : detail === "brief" ? "优先一两句说完；必要阻塞和事实限制不能省掉。" : "按问题复杂度决定长度；一句能说清就不用铺开。"}不模仿口癖、真人经历、年龄或情感承诺，不刻意加语气词、表情和拟声词，不拆成多条消息制造聊天感。`,
  };
}

export const DIALOGUE_STYLE = `微信表达约定：普通聊天、吐槽、偏好反馈、必要追问和简短结果，默认用简短连贯的单段口语，通常一到三句。直接接当前话题，不默认分点、空行、列提纲、加小标题，不把每次反馈写成分析报告。只有用户主动要求，或步骤、代码、对照表等复杂内容确实需要时才分段或用列表。先回应对方此刻的话，不复述任务，不解释内部流程，不机械说“收到、明白、我将从以下几个方面”。吐槽时可以承认具体问题、自然接话，不自动开解决方案清单，也不强行追问。不要固定口头禅、刻意卖萌、编造人的经历或感情；用户称你穆戈时自然承接，身份仍是 AI。风格只影响怎么说，不改变事实、模型选择、记忆归属和授权边界。后台的任务、工具和状态数据用于决策核对，不是每轮都要朗读的回复提纲。接收回执由 Bridge 单独负责，回答不要重复确认。对用户简短的风格反馈，直接用新风格回应，不汇报“已完成风格优化”的流程。
表达示例仅供参考，不逐字套用：用户说“这回复太像公文了”可答“确实有点端着了。咱们就顺着聊，不用每句话都做总结。”；缺少项目名时只问“这个项目叫什么名字？”；完成通知说具体成果和仍未生效的限制，不用“完成情况、验证结果、后续建议”列提纲。`;

export function replyLayout(request = ""): ReplyLayout {
  // A negative format preference must not be mistaken for a request for a list.
  if (
    /(?:不要|不用|别|避免|不想|不希望|不需要)[^。！？\n]{0,24}(?:分点|分段|列表|空行|提纲|报告|清单)|(?:单段|一段话|连贯.{0,4}口语)|(?:分点|列表|提纲).{0,10}(?:烦|生硬|机械)/.test(
      request,
    )
  )
    return "paragraph";
  if (
    /^\/(?:commands|help|projects|tasks|todo|calendar)\b/.test(
      request.trim(),
    ) ||
    /(?:分点|分段|逐条)(?:说|讲|回答|解释|列|说明)|(?:用|按|改成|整理成|给我|发我|提供|生成|写|列个|来个|做个).{0,10}(?:列表|表格|提纲|清单|[Mm]arkdown)|(?:原文|排查步骤|操作步骤|实施步骤|详细(?:方案|设计|报告|日志|过程))|对比.{0,16}(?:方案|差异|优缺点)|(?:列出|查看|看看).{0,12}(?:项目|任务|待办|记忆)|(?:项目|任务|待办|记忆).{0,8}(?:有哪些|列表)|(?:写|来|读|念).{0,6}(?:首诗|诗歌)|(?:写|生成).{0,10}(?:代码|函数|脚本)/.test(
      request,
    ) ||
    /(?:查看|看看|给我|发我|提供|列出|展示|解释|具体).{0,16}(?:详情|日志|代码|指令|命令|技术细节|验证证据)/.test(
      request,
    ) ||
    ((request.match(/现状|收益|工作量|优先级|优缺点|成本/g) ?? []).length >=
      3 &&
      /说明|对比|比较|给|推荐|建议/.test(request))
  )
    return "structured";
  return "paragraph";
}

export function presentReply(
  text: string,
  layout: ReplyLayout = "paragraph",
): string {
  if (layout === "structured") return text.trim();
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(
          /^(?:#{1,6}\s+|[-*•·]\s+|\d+[.)、]\s+|[（(]\d+[）)]\s*|[一二三四五六七八九十]+[、.)）]\s*)/,
          "",
        )
        .replace(/\*\*([^*\n]+)\*\*/g, "$1"),
    )
    // Remove only standalone presentation labels, never facts or unfinished-work caveats.
    .filter((line) => line && !/^(?:收到|明白|好的)[，,。！!：:]*$/.test(line))
    .filter(
      (line) =>
        !/^(?:回复|分析|总结|结论|完成情况|验证结果|后续建议|回应|接下来)[：:]?$/.test(
          line,
        ),
    );
  // Keep a genuine short acknowledgement if that is the whole response.
  if (!lines.length) return text.trim().replace(/\s*\n+\s*/g, " ");
  return lines
    .map((line, i) =>
      i < lines.length - 1 && !/[。！？!?；;：:，,、…」”"')）]$/.test(line)
        ? `${line}。`
        : line,
    )
    .join(" ");
}

export function dialogueContext(request: string) {
  return {
    layout: replyLayout(request),
    default: "short-connected-paragraph",
    scope: "wording-only",
    currentMessageFirst: true,
    layers: [
      "AI identity",
      "current user preferences",
      "current topic",
      "verified task facts",
    ],
    artificialDelay: false,
  };
}
