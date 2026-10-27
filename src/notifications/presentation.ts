import { safeText } from "../security/policy.js";
import { presentReply, type ReplyLayout } from "../app/dialogue.js";

export const RECEIPT_DELAY_MS = 800;
export const RECEIPT_TTL_MS = 15_000;
export const PRESENTATION_REVISION = 2;

// Only a timing hint, never an authorization or business-routing decision.
// Unclear messages wait for the intent decision instead of receiving a fake work notice.
export function wantsReceipt(text: string): boolean {
  const value = text.trim();
  if (/^\/(?:run|continue)\b/i.test(value)) return true;
  if (/^\//.test(value)) return false;
  if (/不要|不用|不必|暂不|暂时不|什么意思|是什么/.test(value)) return false;
  if (
    /^(?:怎么|如何|为什么|什么是|解释|介绍|翻译|讲讲)|(?:怎么|如何)(?:创建|新建|修改|修复)|(?:建议|思路|可行性|什么意思|有哪些)[？?。！!\s]*$/.test(
      value,
    )
  )
    return false;
  if (
    !/[？?]|可以吗|行不行|是否|能否/.test(value) &&
    /^(?:请|麻烦|帮我)?(?:让|用|在).{1,24}(?:对话|会话|来|里|中).{0,8}(?:覆盖|同步|整理|继续|处理|开展|执行)/.test(
      value,
    )
  )
    return true;
  return (
    /(?:帮我|请|麻烦|继续|实现|修复|优化|修改|新建|创建|打包|部署|检查并)/.test(
      value,
    ) &&
    /(?:实现|修复|优化|修改|新建|创建|打包|部署|整理|导出|检查并)/.test(
      value,
    ) &&
    /(?:项目|功能|代码|程序|软件|页面|文件|任务|报告|资料|文献|图标|通知|回执|App|EXE|bug)/i.test(
      value,
    )
  );
}

export function receiptText(index: number): string {
  return ["收到了，我处理一下。", "收到，我来看看这件事。", "好，需求收到了。"][
    ((index % 3) + 3) % 3
  ]!;
}

/** Raw exceptions stay in the dashboard. Only known, actionable facts reach WeChat. */
export function friendlyProblem(value: unknown): string {
  const text = String(value ?? "");
  if (/模型|model/i.test(text))
    return "指定模型暂时无法确认或使用，没有自动换用其他模型。";
  if (/数据库.*占用/.test(text)) return "数据库被其他程序占用，暂时无法保存。";
  if (/沙箱|权限|拒绝访问|EACCES|EPERM|access denied/i.test(text))
    return "这一步被当前权限限制挡住了，暂时无法继续。";
  if (/超时|timeout|timed out/i.test(text))
    return "等待响应超时，结果还没确认。";
  if (/断开|中断|未连接|连接|disconnect|connection|socket/i.test(text))
    return "连接出了问题，结果还没确认。";
  if (/自动查(?:询|找|阅).*上限/.test(text))
    return "这次查询达到处理上限，还没拿到完整结果，可以缩小一下查询范围。";
  if (/^格式：\/run/.test(text)) return "请告诉我项目名称和要做的事。";
  if (/目录.*(?:不在|超出|越界|不存在)|路径.*(?:无效|不允许)/.test(text))
    return "这个目录不在可用范围内，请换一个项目目录。";
  // These are bounded Bridge validation questions, not arbitrary provider errors.
  if (
    /^(?:请补充|请说明|请告诉我|没有找到|提醒时间还不明确|项目名称不能为空)/.test(
      text,
    ) &&
    text.length <= 100 &&
    !/[{}\n\\]|[A-Z]:|Error|RPC|stack/i.test(text)
  )
    return safeText(text, 100);
  return "这次没能处理完，具体原因已留在软件后台。";
}

export function notificationPresentation(
  text: string,
  key: string,
  layout: ReplyLayout = "paragraph",
  legacy = false,
) {
  if (/^(?:start|phase):/.test(key))
    return { text: "进度已更新。", backendOnly: true };
  if (/^start-error:/.test(key))
    return { text: `任务启动没有确认。${friendlyProblem(text)}` };
  if (/^boundary-unknown:/.test(key))
    return { text: "这一步受权限限制，停止结果也还没确认，暂时没有重试。" };
  if (/^stale:/.test(key))
    return { text: "这项任务暂时没有新进展，是否仍在处理还没确认。" };
  if (/^timeout:/.test(key))
    return { text: "这项任务等待太久，已请求停止，正在等停止确认。" };
  if (/^expired:/.test(key))
    return { text: "刚才需要确认的操作已过期，没有继续。" };
  if (/^model-mismatch:/.test(key))
    return {
      text: "执行端报告的模型与指定模型不一致，已请求停止，结果还待确认。",
    };
  if (/^unsupported:/.test(key))
    return { text: "这一步需要在软件后台处理，任务暂时无法继续。" };
  // Also clean persisted, unsent dispatch templates from older builds.
  if (
    legacy &&
    /^(?:answer|reply):/.test(key) &&
    /^(?:收到，已交给“[^”]+”[：:][\s\S]*开始和完成时我会告诉你[。！!]?|已在“[^”]+”的项目会话中安排继续[：:][\s\S]*开始和完成时我会告诉你[。！!]?|任务已排队：[\s\S]*|继续指令已排队[：:][\s\S]*)$/.test(
      text,
    )
  )
    return { text: "收到了，我处理一下。" };
  if (/^approval:/.test(key))
    return { text: "这一步需要你确认，请在软件后台查看具体操作后决定。" };
  return { text: presentReply(text, layout) };
}
