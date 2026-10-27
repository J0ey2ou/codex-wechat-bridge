import test from "node:test";
import assert from "node:assert/strict";
import type { Project, Task } from "../src/app/types.js";
import { taskCompletionMessage } from "../src/notifications/task-message.js";

const project: Project = {
  id: "project-internal-id",
  name: "资料整理",
  path: "D:\\private\\project",
  createdAt: 1,
};
function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task-internal-id",
    projectId: project.id,
    title: "处理资料",
    status: "COMPLETED",
    stages: [],
    stageIndex: 0,
    createdAt: 1,
    startedAt: 1000,
    endedAt: 2_121_000,
    lastActivityAt: 2_121_000,
    lastEvent: "completed",
    threadId: "thread-internal-id",
    turnId: "turn-internal-id",
    files: ["D:\\private\\file.ts"],
    tests: ["tsc exitCode=0", "pytest exitCode=1"],
    processIds: ["system-process-id"],
    ...patch,
  };
}

test("completed work keeps meaningful caveats without declaring everything verified", () => {
  const result = taskCompletionMessage(
    task({
      summary:
        "筛选功能已更新。服务尚未重启，当前页面仍显示旧版本。完整流程尚未验证，需要重启后检查。",
    }),
    project,
  );
  assert.ok(result.includes("筛选功能已更新"));
  assert.ok(result.includes("尚未重启"));
  assert.ok(result.includes("尚未验证"));
  assert.ok(!result.includes("全部完成") && !result.includes("COMPLETED"));
});

test("friendly userMessage is primary and internal technical arrays are not appended", () => {
  const result = taskCompletionMessage(
    task({
      userMessage: "重复条目已经合并，列表现在更容易查找了。",
      summary: "implementation detail: reducer and schema adjusted",
    }),
    project,
  );
  assert.ok(result.includes("重复条目已经合并"));
  assert.ok(!result.includes("implementation detail"));
  for (const value of [
    "file.ts",
    "exitCode",
    "system-process-id",
    "2120",
    "主要文件",
    "耗时",
    "task-internal-id",
    "thread-internal-id",
    "turn-internal-id",
  ])
    assert.ok(!result.includes(value), value);
});

test("a friendly answer cannot conceal a limitation present in the stored summary", () => {
  const result = taskCompletionMessage(
    task({
      userMessage: "筛选功能已经调整。",
      summary: "功能逻辑已更新。尚未运行完整测试，不能确认所有场景正常。",
    }),
    project,
  );
  assert.ok(result.includes("筛选功能已经调整"));
  assert.ok(result.includes("尚未运行完整测试"));
});

test("matching limitation topics are not repeated from technical summaries", () => {
  const result = taskCompletionMessage(
    task({
      userMessage: "页面已经调整，服务还没有重启。",
      summary: "修改已保存。服务尚未重启，需要重启后检查。",
    }),
    project,
  );
  assert.ok(result.includes("服务还没有重启"));
  assert.ok(!result.includes("服务尚未重启"));
});

test("a failed turn does not send optimistic success claims", () => {
  const premature = "新版本已经全部发布，现在就能使用。";
  const result = taskCompletionMessage(
    task({
      status: "FAILED",
      userMessage: premature,
      error: "Deploy D:\\private\\app.js failed: exit code 23",
    }),
    project,
  );
  assert.ok(!result.includes(premature));
  assert.ok(result.includes("没能完成"));
  assert.ok(result.includes("软件后台"));
  assert.ok(!/D:\\|exit code|private/.test(result));
});

test("failed tasks explain incompletion and the actual reason", () => {
  const result = taskCompletionMessage(
    task({
      status: "FAILED",
      userMessage: "已经完成初步检查，但更新尚未写入。",
      error: "数据库被其他程序占用，无法保存修改。",
    }),
    project,
  );
  assert.ok(result.includes("没能完成"));
  assert.ok(result.includes("尚未写入"));
  assert.ok(result.includes("数据库被其他程序占用"));
  assert.ok(!result.includes("FAILED"));
});

test("interrupted tasks preserve partial progress and clearly say they stopped", () => {
  const result = taskCompletionMessage(
    task({
      status: "INTERRUPTED",
      summary: "已检查两份资料，其余资料未完成。",
      error: "用户已中断",
    }),
    project,
  );
  assert.ok(result.includes("已停止"));
  assert.ok(result.includes("任务未完成"));
  assert.ok(result.includes("已检查两份资料"));
  assert.ok(result.includes("停止请求"));
});

test("legacy raw metadata is removed but validation failures remain visible", () => {
  const result = taskCompletionMessage(
    task({
      summary:
        "已更新页面布局。\n状态：COMPLETED\n主要文件：D:\\private\\file.ts\nD:\\private\\another.ts\n测试：node check.js exitCode=1 failed\n耗时：2120秒\nID：task-internal-id\n尚未部署到运行环境。",
    }),
    project,
  );
  assert.ok(result.includes("已更新页面布局"));
  assert.ok(result.includes("验证未通过"));
  assert.ok(result.includes("尚未部署"));
  assert.ok(
    !/exitCode|COMPLETED|2120|private|internal-id|主要文件/.test(result),
  );
});

test("structured legacy summaries expose only their human summary", () => {
  const result = taskCompletionMessage(
    task({
      summary: JSON.stringify({
        summary: "内容已经整理，尚未验收。",
        files: ["D:\\private\\file.ts"],
        tests: ["exitCode=0"],
      }),
    }),
    project,
  );
  assert.ok(result.includes("内容已经整理"));
  assert.ok(result.includes("尚未验收"));
  assert.ok(!/files|tests|private|exitCode/.test(result));
});

test("long output stays bounded while late caveats and failure reasons are retained", () => {
  const result = taskCompletionMessage(
    task({
      status: "FAILED",
      summary:
        "已完成部分调整。".repeat(160) + "服务尚未重启，端到端流程尚未验证。",
      error: "保存时连接超时。",
    }),
    project,
  );
  assert.ok(result.length <= 600, String(result.length));
  assert.ok(result.includes("尚未重启"));
  assert.ok(result.includes("尚未验证"));
  assert.ok(result.includes("响应超时"));
});

test("missing results do not invent accomplishments", () => {
  const result = taskCompletionMessage(task(), project);
  assert.ok(result.includes("没有收到可用的结果说明"));
  assert.ok(result.includes("尚无法确认"));
  assert.ok(!/全部完成|验证通过|已修改|测试通过/.test(result));
  const failed = taskCompletionMessage(task({ status: "FAILED" }), project);
  assert.ok(
    failed.includes("没能完成") && failed.includes("没有收到具体失败原因"),
  );
});

test("messages redact credentials before shortening and never mutate stored technical evidence", () => {
  const input = task({
    userMessage:
      '保存失败，password=super-secret，返回配置 {"access_token":"secret-token-value"}。Bearer sensitive-bearer-token',
    error: "sk-abcdefghijklmnop",
  });
  const before = JSON.stringify(input);
  const result = taskCompletionMessage(input, project);
  for (const secret of [
    "super-secret",
    "secret-token-value",
    "sensitive-bearer-token",
    "sk-abcdefghijklmnop",
  ])
    assert.ok(!result.includes(secret), secret);
  assert.equal(JSON.stringify(input), before);
});
