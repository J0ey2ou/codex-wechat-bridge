import type { Project } from "./types.js";

export function friendlyHelp(projects: Project[]): string {
  return `直接像平时聊天一样告诉我就行，不用记指令。\n\n例如：“我的项目有哪些”“打开某个软件”“看看某软件里今天的待办”“明天下午三点提醒我交报告”。也可以问问题、追问、让我解释或写一段话。\n\n扫码绑定后就能使用，我会自己查找项目和软件，不需要逐个配置或授权。缺少具体目标或时间时再问你。`;
}
