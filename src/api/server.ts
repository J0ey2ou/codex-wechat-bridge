import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import type { Bridge } from "../app/bridge.js";
import type {
  Approval,
  Delivery,
  Project,
  Reminder,
  Task,
} from "../app/types.js";
import { validateSettings } from "../app/config.js";
import { ILinkAdapter } from "../channels/wechat/ilink.js";
import { MockWeChat } from "../channels/wechat/mock.js";
import { safeText } from "../security/policy.js";
import { messageLatency } from "../notifications/latency.js";
import type { Question } from "../codex/questions.js";
import { executionProject } from "../computer/projects.js";
import { answerAccount } from "../codex/account.js";
import {
  ThreadContinuation,
  CONTINUATION_REVISION,
} from "../codex/continuation.js";
import { ThreadTargets } from "../codex/thread-target.js";
import { effectiveVoice } from "../app/dialogue.js";
import { BUILD } from "../app/build.js";
import { localReport } from "../reports/local.js";
export function createApi(bridge: Bridge, port = bridge.config.port) {
  const report = (
    name: "runtime-upgrade-report" | "project-issues" | "notification-report",
  ) =>
    readFileSync(new URL(`../ui/${name}.txt`, import.meta.url), "utf8") +
    localReport(
      bridge.config.dataDir,
      bridge.store.setting("boundUser", ""),
      name,
    );
  const continuation = new ThreadContinuation(
    bridge.store,
    bridge.tasks,
    bridge.codex,
    bridge.computer.workspaces,
  );
  const currentUser = () => {
    const user = bridge.store.setting("boundUser", "");
    if (!user) throw new Error("请先绑定微信用户");
    return user;
  };
  const idle = (all = false) => {
    if (
      bridge.store
        .all<Question>("questions")
        .some(
          (q) =>
            q.userId === bridge.store.setting("boundUser", "") &&
            ["queued", "running", "dispatching"].includes(q.status),
        ) ||
      (all &&
        bridge.tasks
          .tasks()
          .some(
            (t) => !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status),
          ))
    )
      throw new Error("请等待当前对话或任务完成后再操作，避免切换中的数据混用");
  };
  const csrf = randomBytes(32).toString("hex");
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req: IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Error("仅接受 application/json");
    let data = "";
    for await (const c of req) {
      data += c;
      if (Buffer.byteLength(data) > 64000) throw new Error("请求体过大");
    }
    return data ? JSON.parse(data) : {};
  }
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      !hosts.has(req.headers.host ?? "") ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      )
    ) {
      json(res, 403, { error: "仅允许本机访问" });
      return;
    }
    if (
      (req.headers.origin &&
        !["http://" + req.headers.host].includes(req.headers.origin)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      json(res, 403, { error: "拒绝跨站请求" });
      return;
    }
    const route = (req.url ?? "/").split("?")[0];
    try {
      if (
        req.method === "GET" &&
        [
          "/",
          "/app.js",
          "/style.css",
          "/manifest.webmanifest",
          "/icon.svg",
          "/sw.js",
        ].includes(route!)
      ) {
        const f = route === "/" ? "index.html" : route!.slice(1);
        const url = new URL(`../ui/${f}`, import.meta.url);
        let content: Buffer;
        try {
          content = readFileSync(url);
        } catch {
          content = readFileSync(
            new URL(`../../../../src/ui/${f}`, import.meta.url),
          );
        }
        res.setHeader(
          "Content-Type",
          f.endsWith(".webmanifest")
            ? "application/manifest+json; charset=utf-8"
            : f.endsWith(".svg")
              ? "image/svg+xml"
              : f.endsWith(".js")
                ? "text/javascript; charset=utf-8"
                : f.endsWith(".css")
                  ? "text/css; charset=utf-8"
                  : "text/html; charset=utf-8",
        );
        res.end(content);
        return;
      }
      if (req.method === "GET" && route === "/api/bootstrap") {
        json(res, 200, {
          csrf,
          version: "0.3.0",
          name: "鲁滨逊",
          build: BUILD,
        });
        return;
      }
      const supplied = String(req.headers["x-bridge-token"] ?? "");
      if (
        supplied.length !== csrf.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrf))
      ) {
        json(res, 403, { error: "本机管理会话失效，请刷新页面" });
        return;
      }
      const b = req.method === "POST" ? await body(req) : {};
      let result: unknown = { ok: true };
      if (req.method === "GET" && route === "/api/reports") {
        result = bridge.reports.list(currentUser());
      } else if (req.method === "POST" && route === "/api/reports/download") {
        const file = bridge.reports.read(String(b.id ?? ""), currentUser());
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "Content-Length": file.bytes.length,
        });
        res.end(file.bytes);
        return;
      } else if (req.method === "GET" && route === "/api/memory") {
        result = {
          ...bridge.memory.view(currentUser()),
          effectiveVoice: effectiveVoice(bridge.memory.context(currentUser())),
        };
      } else if (req.method === "GET" && route === "/api/openai/status") {
        result = await bridge.auth.status();
      } else if (req.method === "GET" && route === "/api/evidence") {
        result = {
          records: bridge.store.all("inference_records").slice(0, 100),
          note: "threadModel 是服务端会话配置；actualModel 仅在轮次明确报告时填写。token 不等于余额；额度请使用 Bridge 账户查询核实。",
        };
      } else if (req.method === "GET" && route === "/api/notification-report") {
        result = {
          text: report("notification-report"),
        };
      } else if (req.method === "GET" && route === "/api/project-issues") {
        result = {
          text: report("runtime-upgrade-report") + report("project-issues"),
        };
      } else if (req.method === "GET" && route === "/api/state") {
        result = {
          version: "0.3.0",
          build: BUILD,
          runtime: {
            managed: process.env.ROBINSON_MANAGED === "1",
            bundledCodex: process.env.ROBINSON_BUNDLED_CODEX === "1",
          },
          name: "鲁滨逊",
          capabilities: {
            originalThreadContinuation: CONTINUATION_REVISION,
            pdfReports: "ilink-file-v1",
            desktopActivity: "read-only-observation-v1",
          },
          messageLatency: messageLatency(bridge.store),
          modes: {
            codex: bridge.config.codexMode,
            wechat: bridge.config.wechatMode,
          },
          connections: {
            codex: bridge.codex.connected,
            wechat: bridge.channel.getConnectionStatus(),
            codexError: bridge.store.setting("codexError", null),
          },
          projects: bridge.tasks.projects(),
          availableProjects: bridge.computer.workspaces.snapshot().projects,
          tasks: bridge.tasks.tasks(),
          routingRequests: bridge.store.all("routing_requests").slice(0, 30),
          reports: bridge.store.all("pdf_reports").slice(0, 30),
          messageAnalysis: bridge.store
            .all<Question>("questions")
            .filter((q) => q.userId === bridge.store.setting("boundUser", ""))
            .slice(0, 20)
            .map(({ toolCalls, ...question }) => ({
              ...question,
              toolCalls: toolCalls?.map(({ request, completedAt }) => ({
                request,
                completedAt,
              })),
            })),
          discoveredWorkspaces: bridge.computer.workspaces.snapshot(),
          approvals: bridge.store
            .all<Approval>("approvals")
            .filter((a) => a.status === "pending"),
          todos: bridge.todos.list(),
          reminders: bridge.store.all<Reminder>("reminders"),
          deliveries: bridge.store
            .all<Delivery>("notification_deliveries")
            .filter((d) => d.userId === bridge.store.setting("boundUser", ""))
            .slice(0, 40),
          boundUser: bridge.store.setting("boundUser", null),
          heartbeat: bridge.store.setting("heartbeat", null),
          error: bridge.store.setting("lastBackgroundError", null),
          settings: {
            timezone: bridge.config.timezone,
            collectionMinutes: bridge.config.collectionMinutes,
            staleMinutes: bridge.config.staleMinutes,
            timeoutMinutes: bridge.config.timeoutMinutes,
            approvalMinutes: bridge.config.approvalMinutes,
            notifyProgress: bridge.config.notifyProgress,
            wechatPushEnabled: bridge.notices.isPushEnabled(),
            autoContinueLowRisk: bridge.config.autoContinueLowRisk,
            executionAuthorization: bridge.config.executionAuthorization,
          },
          desktopCapabilities: bridge.desktop.capabilities,
          desktopCompletion: bridge.completions.snapshot(),
          desktopActivity: bridge.activity.snapshot(),
        };
      } else if (req.method === "POST")
        switch (route) {
          case "/api/activity/refresh":
            await bridge.activity.tick(Date.now(), true);
            result = bridge.activity.snapshot();
            break;
          case "/api/openai/login":
            idle(true);
            await bridge.connectCodex();
            result = await bridge.auth.start();
            break;
          case "/api/openai/cancel":
            await bridge.auth.cancel();
            break;
          case "/api/openai/logout":
            idle(true);
            await bridge.auth.logout();
            break;
          case "/api/openai/usage":
            result = {
              checkedAt: Date.now(),
              account: await bridge.auth.status(),
              limits: await answerAccount(
                bridge.codex,
                "剩余额度",
                bridge.config.timezone,
              ),
            };
            break;
          case "/api/memory/save":
          case "/api/memory/delete":
          case "/api/memory/settings":
          case "/api/memory/clear": {
            idle();
            if (b.userId !== undefined || b.ownerId !== undefined)
              throw new Error("不能指定其他用户");
            const user = currentUser();
            if (route.endsWith("/save"))
              result = bridge.memory.save(
                user,
                String(b.text ?? ""),
                "dashboard",
                b.id === undefined ? undefined : String(b.id),
              );
            if (route.endsWith("/delete"))
              result = bridge.memory.remove(user, String(b.id));
            if (route.endsWith("/settings"))
              result = bridge.memory.update(user, b);
            if (route.endsWith("/clear")) {
              if (b.confirm !== "清空我的记忆")
                throw new Error("请明确确认清空范围");
              result = bridge.memory.clear(user, b.history === true);
            }
            break;
          }
          case "/api/projects/add":
            result = bridge.tasks.addProject(
              String(b.name ?? ""),
              String(b.path ?? ""),
            );
            break;
          case "/api/projects/remove":
            bridge.tasks.removeProject(String(b.id));
            break;
          case "/api/runtime/stop":
            idle(true);
            if (
              bridge.store
                .all<Delivery>("notification_deliveries")
                .some((d) => ["pending", "retry", "sending"].includes(d.status))
            )
              throw new Error("消息仍在发送，稍后再退出即可");
            if (!bridge.onShutdown)
              throw new Error("当前运行方式不支持受控退出");
            setImmediate(() => bridge.onShutdown?.());
            break;
          case "/api/tasks/create":
            const selectedProject = await executionProject(
              bridge.tasks,
              bridge.computer.workspaces,
              String(b.projectId),
            );
            result = bridge.tasks.create(
              selectedProject.id,
              String(b.title ?? ""),
              b.stages,
            );
            break;
          case "/api/tasks/stop":
            await bridge.tasks.stop(String(b.id));
            break;
          case "/api/tasks/resolve":
            if (b.confirm !== "已确认停止")
              throw new Error("必须确认旧进程已停止");
            bridge.tasks.resolveUnknown(String(b.id));
            break;
          case "/api/approvals/decide":
            if (!["approve", "reject"].includes(b.decision))
              throw new Error("无效决定");
            await bridge.tasks.decide(String(b.id), b.decision, true);
            break;
          case "/api/approvals/modify":
            await bridge.tasks.modifyApproval(
              String(b.id),
              String(b.text ?? ""),
            );
            break;
          case "/api/todos/add":
            result = bridge.todos.add(
              String(b.text ?? ""),
              "local:" + randomUUID(),
            );
            break;
          case "/api/todos/change":
            if (!["done", "cancelled"].includes(b.status))
              throw new Error("无效待办状态");
            result = bridge.todos.change(String(b.id), b.status);
            break;
          case "/api/todos/confirm":
            result = bridge.todos.confirm(String(b.id), String(b.date ?? ""));
            break;
          case "/api/todos/edit":
            result = bridge.todos.edit(String(b.id), String(b.text ?? ""));
            break;
          case "/api/reminders/add":
            result = bridge.todos.remind(
              String(b.todoId),
              String(b.date),
              b.repeatMinutes,
            );
            break;
          case "/api/settings": {
            const patch = Object.fromEntries(
              Object.entries(b).filter(([k]) =>
                [
                  "timezone",
                  "collectionMinutes",
                  "staleMinutes",
                  "timeoutMinutes",
                  "approvalMinutes",
                  "notifyProgress",
                  "wechatPushEnabled",
                  "autoContinueLowRisk",
                ].includes(k),
              ),
            );
            validateSettings(patch);
            Object.assign(bridge.config, patch);
            bridge.store.setSetting("preferences", {
              ...bridge.store.setting("preferences", {}),
              ...patch,
            });
            if (typeof patch.wechatPushEnabled === "boolean")
              bridge.notices.setPushEnabled(patch.wechatPushEnabled);
            break;
          }
          case "/api/codex/check":
            await bridge.connectCodex();
            if (!bridge.codex.connected)
              throw new Error(
                bridge.store.setting("codexError", "无法连接 Codex"),
              );
            {
              const a = await bridge.codex.request("account/read", {
                refreshToken: false,
              });
              result = {
                connected: true,
                accountType: a.account?.type ?? null,
                requiresOpenaiAuth: a.requiresOpenaiAuth,
              };
            }
            break;
          case "/api/sessions/list":
            result = {
              data: await new ThreadTargets(bridge.store, bridge.codex).list(
                await executionProject(
                  bridge.tasks,
                  bridge.computer.workspaces,
                  String(b.projectId),
                ),
                currentUser(),
              ),
              nextCursor: null,
            };
            break;
          case "/api/sessions/inspect":
            result = await continuation.inspect(currentUser(), b);
            break;
          case "/api/sessions/continue": {
            const task = await continuation.submit(currentUser(), b);
            result = {
              task,
              accepted: true,
              resumed: !!task.targetResumedAt,
              note: task.turnId
                ? "已确认原轮次编号，请按任务状态查看结果。"
                : "要求已保存排队，尚未确认开始执行。",
            };
            break;
          }
          case "/api/sessions/continuation/status":
            result = { task: continuation.status(currentUser(), b.requestId) };
            break;
          case "/api/sessions/fork": {
            const p = bridge.tasks.project(String(b.projectId));
            if (
              bridge.tasks
                .tasks()
                .some(
                  (t) =>
                    t.projectId === p.id &&
                    !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status),
                )
            )
              throw new Error("项目有未结束任务");
            const r = await bridge.desktop.fork(p, String(b.threadId));
            p.sessionId = r.thread.id;
            p.sessionOrigin = "desktop-fork";
            bridge.store.put("projects", p);
            bridge.store.put("codex_sessions", {
              id: r.thread.id,
              projectId: p.id,
              origin: "desktop-fork",
              sourceThreadId: b.threadId,
            });
            result = { threadId: r.thread.id };
            break;
          }
          case "/api/wechat/login": {
            if (!(bridge.channel instanceof ILinkAdapter))
              throw new Error("Mock 模式没有真实二维码");
            const q = await bridge.channel.startLogin();
            result = {
              id: q.id,
              image: await QRCode.toDataURL(q.content, {
                width: 280,
                margin: 2,
              }),
              status: "wait",
            };
            break;
          }
          case "/api/wechat/poll":
            if (!(bridge.channel instanceof ILinkAdapter))
              throw new Error("仅真实微信模式支持");
            result = await bridge.channel.pollLogin(String(b.id), b.verifyCode);
            break;
          case "/api/wechat/bind":
            if (b.confirm !== "本机确认") throw new Error("需要本机确认");
            if (bridge.channel instanceof ILinkAdapter)
              await bridge.channel.confirmBinding(String(b.userId));
            else {
              if (bridge.store.setting("boundUser", null))
                throw new Error("请先解绑");
              bridge.store.setSetting("boundUser", String(b.userId));
            }
            break;
          case "/api/wechat/unbind":
            idle(true);
            if (b.confirm !== "本机确认") throw new Error("需要本机确认");
            if (
              bridge.tasks
                .tasks()
                .some(
                  (t) =>
                    !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status),
                )
            )
              throw new Error("请先结束所有任务再解绑");
            if (bridge.channel instanceof ILinkAdapter)
              await bridge.channel.unbind();
            else bridge.store.setSetting("boundUser", null);
            break;
          case "/api/mock/message":
            if (!(bridge.channel instanceof MockWeChat))
              throw new Error("真实模式禁用模拟输入");
            await bridge.channel.inject({
              id: randomUUID(),
              userId: bridge.store.setting("boundUser", ""),
              text: String(b.text),
              sentAt: Date.now(),
              kind: b.forwarded ? "forwarded" : "direct",
            });
            break;
          default:
            json(res, 404, { error: "接口不存在" });
            return;
        }
      else {
        json(res, 404, { error: "接口不存在" });
        return;
      }
      json(res, 200, result);
    } catch (e) {
      json(res, 400, {
        error: safeText(e instanceof Error ? e.message : e, 1200),
      });
    }
  });
}
