import test from "node:test";
import assert from "node:assert/strict";
import { desktopCompletionMessage } from "../src/notifications/task-message.js";

test("desktop results keep readable link labels and omit files, code and test logs", () => {
  const message = desktopCompletionMessage(
    "整理资料",
    [
      "页面已经调整，详情见[修改说明](D:/private/report.md)。",
      "## 主要文件",
      "- [main.ts](D:/private/src/main.ts)",
      "- /home/joe/private/notes.txt",
      "## 验证",
      "- `npm run check`：通过，exit code 0",
      "```js\nconsole.log('internal implementation');\n```",
      "服务尚未重启，请手动重启后确认。",
    ].join("\n"),
  );
  assert.ok(message.startsWith("“整理资料”有新结果了。"));
  assert.ok(message.includes("修改说明"));
  assert.ok(message.includes("尚未重启"));
  assert.doesNotMatch(
    message,
    /D:\/|private|main\.ts|npm|exit code|console|```|主要文件/,
  );
});

test("failed checks and necessary user actions survive log removal", () => {
  const message = desktopCompletionMessage(
    "更新页面",
    [
      "- node --test checks.js exitCode=1",
      "部署失败，账号需要重新登录才能继续。",
      "修改位于 /home/joe/project/app.ts，尚未部署。",
    ].join("\n"),
  );
  assert.ok(message.includes("有执行未通过"));
  assert.ok(message.includes("部署失败"));
  assert.ok(message.includes("需要重新登录"));
  assert.ok(message.includes("尚未部署"));
  assert.doesNotMatch(message, /checks\.js|exitCode|\/home\/joe/);
});

test("long desktop notices retain late action requirements within 600 characters", () => {
  const message = desktopCompletionMessage(
    "项目".repeat(90),
    "已整理一部分资料。".repeat(150) +
      "剩余数据未完成。需要你上传缺失的数据后继续。服务尚未重启。",
  );
  assert.ok(message.length <= 600);
  assert.ok(message.includes("未完成"));
  assert.ok(message.includes("需要你上传"));
  assert.ok(message.includes("尚未重启"));
});

test("desktop notices redact secrets and do not invent a result from empty technical output", () => {
  const redacted = desktopCompletionMessage(
    "账号检查",
    "保存失败，password=very-secret-value，Bearer private-access-token",
  );
  assert.doesNotMatch(redacted, /very-secret-value|private-access-token/);
  const empty = desktopCompletionMessage(
    "",
    "```text\nprivate log\n```\n测试：exit code 0",
  );
  assert.ok(empty.includes("具体成果尚无法确认"));
  assert.doesNotMatch(empty, /全部完成|测试通过|private log/);
});
