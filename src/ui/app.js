let token = "",
  state,
  qr,
  qrUser,
  activePage = "home",
  settingsLoaded = false,
  qrPolling = false;
const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function message(text, error = false) {
  $("banner").hidden = false;
  $("banner").textContent = text;
  $("banner").className = error ? "error" : "";
}
async function api(route, data) {
  const r = await fetch("/api/" + route, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "X-Bridge-Token": token,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error ?? "请求失败");
  return value;
}
async function action(fn) {
  try {
    await fn();
    await refresh();
  } catch (e) {
    message(e.message, true);
  }
}
function button(text, fn, cls = "secondary") {
  const b = el("button", text, cls);
  b.onclick = () =>
    action(async () => {
      b.disabled = true;
      try {
        await fn();
      } finally {
        b.disabled = false;
      }
    });
  return b;
}
function date(t) {
  return t
    ? new Date(t).toLocaleString("zh-CN", {
        timeZone: state?.settings.timezone ?? "Asia/Shanghai",
      })
    : "—";
}
function list(id, items, render) {
  const root = $(id);
  root.replaceChildren();
  if (!items.length) root.append(el("div", "暂无记录", "empty"));
  else items.forEach((x) => root.append(render(x)));
}
const isOpen = (t) =>
  !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status);
function badge(status) {
  return el(
    "span",
    status,
    "pill" +
      ([
        "UNKNOWN",
        "WAITING_APPROVAL",
        "draft",
        "retry",
        "delivery_unverified",
      ].includes(status)
        ? " warn"
        : ["FAILED", "failed"].includes(status)
          ? " bad"
          : ""),
  );
}
function row(title, status, description) {
  const r = el("div", undefined, "row"),
    head = el("div", undefined, "row-head");
  head.append(el("strong", title), badge(status));
  r.append(head, el("p", description));
  return r;
}
function taskRow(t) {
  const project = state.projects.find((p) => p.id === t.projectId);
  const r = row(
    t.title,
    t.status,
    `${project?.name ?? "已移除项目"} · 阶段 ${t.stageIndex + 1}/${t.stages.length} · ${date(t.lastActivityAt)}\n${t.lastEvent}`,
  );
  const a = el("div", undefined, "actions");
  a.append(
    button("查看详情", () => {
      const d = $("detail-content");
      d.replaceChildren(
        el("h2", t.title),
        el(
          "pre",
          `任务：${t.id}\n状态：${t.status}\n开始：${date(t.startedAt)}\n运行：${Math.max(0, Math.round(((t.endedAt ?? Date.now()) - (t.startedAt ?? Date.now())) / 1000))} 秒\n最近活动：${date(t.lastActivityAt)}\n阶段：${t.stages[t.stageIndex]?.title}\n事件：${t.lastEvent}\n需要操作：${["UNKNOWN", "WAITING_APPROVAL"].includes(t.status) ? "是" : "否"}\n预计剩余：无可靠依据\n外部进程标识：${t.processIds.join("、") || "服务端未报告"}\n\n结果：${t.summary ?? "待生成"}\n文件：${t.files.join("\n") || "未报告"}\n验证：${t.tests.join("\n") || "未报告"}\n错误：${t.error ?? "无"}`,
        ),
      );
      $("detail").showModal();
    }),
  );
  if (isOpen(t))
    a.append(
      button("请求停止", () => api("tasks/stop", { id: t.id }), "danger"),
    );
  if (t.status === "UNKNOWN")
    a.append(
      button(
        "确认旧任务已停止",
        async () => {
          if (
            confirm(
              "请先检查 Codex 和外部进程。确认它们已经停止后，才可解除项目队列锁。",
            )
          )
            await api("tasks/resolve", { id: t.id, confirm: "已确认停止" });
        },
        "danger",
      ),
    );
  r.append(a);
  return r;
}
function approvalRow(a) {
  const r = row(
      a.kind === "stage" ? "下一阶段审批" : "操作审批",
      a.localOnly ? "仅本机审批" : "等待审批",
      `${a.description}\n风险：${a.risk}\n编号：${a.id}\n到期：${date(a.expiresAt)}`,
    ),
    buttons = el("div", undefined, "actions");
  if (a.allowed)
    buttons.append(
      button("批准这一次", async () => {
        if (confirm(`确认批准以下操作？\n${a.description}\n${a.risk}`))
          await api("approvals/decide", { id: a.id, decision: "approve" });
      }),
    );
  buttons.append(
    button(
      "拒绝",
      () => api("approvals/decide", { id: a.id, decision: "reject" }),
      "danger",
    ),
    button("修改要求", async () => {
      const text = prompt("输入新的任务要求");
      if (text) await api("approvals/modify", { id: a.id, text });
    }),
  );
  r.append(buttons);
  return r;
}
function todoRow(t) {
  const r = row(
      t.title,
      t.status,
      `${t.id} · ${t.dueAt ? date(t.dueAt) : (t.ambiguity ?? "无日期")}`,
    ),
    a = el("div", undefined, "actions");
  if (t.status === "draft")
    a.append(
      button("确认日期", async () => {
        const value = prompt("输入 YYYY-MM-DD HH:mm，或 无日期");
        if (value) await api("todos/confirm", { id: t.id, date: value });
      }),
    );
  a.append(
    button("完成", () => api("todos/change", { id: t.id, status: "done" })),
    button("修改", async () => {
      const text = prompt("修改待办内容和日期", t.title);
      if (text) await api("todos/edit", { id: t.id, text });
    }),
    button("设置提醒", async () => {
      const value = prompt("提醒时间：YYYY-MM-DD HH:mm");
      if (!value) return;
      const repeat = prompt("重复间隔（分钟），留空为单次", "");
      if (repeat === null) return;
      await api("reminders/add", {
        todoId: t.id,
        date: value,
        ...(repeat ? { repeatMinutes: Number(repeat) } : {}),
      });
    }),
    button(
      "取消",
      () => api("todos/change", { id: t.id, status: "cancelled" }),
      "danger",
    ),
  );
  r.append(a);
  return r;
}
function reminderRow(r) {
  const t = state.todos.find((t) => t.id === r.todoId);
  return row(
    t?.title ?? r.todoId,
    r.status,
    `${date(r.dueAt)}${r.repeatMinutes ? ` · 每 ${r.repeatMinutes} 分钟` : ""}`,
  );
}
function render() {
  const open = state.tasks.filter(isOpen);
  const cards = [
    [
      "微信通道",
      state.connections.wechat,
      state.boundUser ? "已绑定用户" : "等待扫码与本机确认",
    ],
    [
      "Codex",
      state.connections.codex ? "已连接" : "未连接",
      state.modes.codex === "mock" ? "MOCK · 模拟模式" : "官方 App Server",
    ],
    ["执行中任务", String(open.length), "未知状态也计入未结束任务"],
    ["待处理审批", String(state.approvals.length), "每次批准均绑定唯一编号"],
  ];
  $("connections").replaceChildren(
    ...cards.map(([label, value, hint]) => {
      const e = el("div", undefined, "metric");
      e.append(
        el("div", label, "label"),
        el("strong", value),
        el("small", hint),
      );
      return e;
    }),
  );
  list("active-tasks", open.slice(0, 4), taskRow);
  list("recent-tasks", state.tasks.slice(0, 6), taskRow);
  list("home-approvals", state.approvals.slice(0, 3), approvalRow);
  $("approval-count").textContent = state.approvals.length;
  list("approvals", state.approvals, approvalRow);
  list("task-list", state.tasks, taskRow);
  list(
    "todo-list",
    state.todos.filter((t) => ["open", "draft"].includes(t.status)),
    todoRow,
  );
  const reminders = state.reminders
    .filter((r) => r.status !== "cancelled")
    .sort((a, b) => a.dueAt - b.dueAt);
  list("home-reminders", reminders.slice(0, 5), reminderRow);
  list("reminder-list", reminders, reminderRow);
  list("delivery-list", state.deliveries, (d) =>
    row(
      d.text.slice(0, 100),
      d.status,
      `${date(d.createdAt)} · 尝试 ${d.attempts} 次 · 手机可见性未验证${d.error ? "\n" + d.error : ""}`,
    ),
  );
  const selected = $("task-project").value;
  $("task-project").replaceChildren(
    ...state.projects.map((p) => {
      const o = el("option", p.name);
      o.value = p.id;
      return o;
    }),
  );
  if (state.projects.some((p) => p.id === selected))
    $("task-project").value = selected;
  list("project-list", state.projects, (p) => {
    const r = el("article");
    r.append(
      el("h2", p.name),
      el("p", p.path),
      el(
        "p",
        `会话：${p.sessionId ?? "尚未创建"} · ${p.sessionOrigin ?? "bridge"}`,
      ),
    );
    const a = el("div", undefined, "actions");
    a.append(
      button("查看已有会话", async () => {
        const data = await api("sessions/list", { projectId: p.id });
        list("session-list", data.data, (s) => {
          const r = row(s.name, s.status?.type ?? "unknown", s.id);
          r.append(
            button("分叉并绑定", async () => {
              if (
                confirm("将创建独立 Bridge 分支，不接管桌面正在运行的会话。")
              ) {
                await api("sessions/fork", { projectId: p.id, threadId: s.id });
                message("已绑定会话分支");
              }
            }),
          );
          return r;
        });
        if (data.nextCursor)
          message("当前显示前 30 条会话，更多记录可通过分页 API 查询。");
      }),
      button(
        "移除授权",
        async () => {
          if (confirm("移除项目授权？不会删除项目文件。"))
            await api("projects/remove", { id: p.id });
        },
        "danger",
      ),
    );
    r.append(a);
    return r;
  });
  $("binding").textContent = state.boundUser
    ? `绑定用户：${state.boundUser}`
    : "尚未绑定微信用户";
  const mock = state.modes.wechat === "mock";
  $("mock-panel").hidden = !mock;
  $("mock-bind").hidden = !mock;
  $("wechat-login").hidden = mock;
  if (!settingsLoaded) {
    const f = $("settings-form");
    for (const [k, v] of Object.entries(state.settings)) {
      const x = f.elements.namedItem(k);
      if (x) {
        if (x.type === "checkbox") x.checked = v;
        else x.value = v;
      }
    }
    settingsLoaded = true;
  }
  $("refresh-time").textContent =
    `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
  if (state.error) message(state.error, true);
  else if (state.connections.codexError)
    message(state.connections.codexError, true);
  else if (mock || state.modes.codex === "mock")
    message("当前包含 MOCK 模拟适配器；结果不能视为真实账号通信成功。");
}
async function refresh() {
  state = await api("state");
  render();
}
function form(id, fn) {
  $(id).onsubmit = (e) => {
    e.preventDefault();
    action(() => fn(Object.fromEntries(new FormData(e.target)), e.target));
  };
}
document.querySelectorAll("nav button").forEach(
  (b) =>
    (b.onclick = () => {
      activePage = b.dataset.page;
      document
        .querySelectorAll(".page")
        .forEach((p) => (p.hidden = p.id !== activePage));
      document
        .querySelectorAll("nav button")
        .forEach((n) => n.classList.toggle("active", n === b));
      $("page-title").textContent = {
        home: "运行概览",
        tasks: "任务与审批",
        todos: "待办与提醒",
        projects: "授权项目",
        settings: "连接与设置",
      }[activePage];
    }),
);
form("project-form", async (data, f) => {
  await api("projects/add", data);
  f.reset();
  message("项目已授权");
});
form("task-form", async (data, f) => {
  const stages = data.stages.trim()
    ? data.stages
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((s, i) => ({
          title: s,
          prompt: s,
          requiresApproval: i > 0,
          lowRisk: false,
        }))
    : undefined;
  await api("tasks/create", {
    projectId: data.projectId,
    title: data.title,
    ...(stages ? { stages } : {}),
  });
  f.elements.title.value = "";
  f.elements.stages.value = "";
  message("任务已保存并排队");
});
form("todo-form", async (data, f) => {
  await api("todos/add", data);
  f.reset();
  message("工作消息已解析，请确认模糊日期");
});
form("settings-form", async (data, f) => {
  for (const k of [
    "collectionMinutes",
    "staleMinutes",
    "timeoutMinutes",
    "approvalMinutes",
  ])
    data[k] = Number(data[k]);
  data.notifyProgress = f.elements.notifyProgress.checked;
  data.autoContinueLowRisk = f.elements.autoContinueLowRisk.checked;
  await api("settings", data);
  message("设置已保存");
});
form("mock-form", async (data, f) => {
  await api("mock/message", {
    text: data.text,
    forwarded: f.elements.forwarded.checked,
  });
  f.elements.text.value = "";
  message("模拟消息已提交");
});
$("refresh").onclick = () => action(refresh);
$("detail-close").onclick = () => $("detail").close();
$("codex-check").onclick = () =>
  action(async () => {
    $("codex-result").textContent = JSON.stringify(
      await api("codex/check", {}),
      null,
      2,
    );
  });
$("mock-bind").onclick = () =>
  action(async () => {
    await api("wechat/bind", { userId: "mock-user", confirm: "本机确认" });
    message("已绑定模拟用户");
  });
$("wechat-unbind").onclick = () =>
  action(async () => {
    if (confirm("确认在本机解除微信绑定？"))
      await api("wechat/unbind", { confirm: "本机确认" });
  });
async function pollQr(verifyCode) {
  if (!qr || qrPolling) return;
  qrPolling = true;
  try {
    const r = await api("wechat/poll", {
      id: qr.id,
      ...(verifyCode ? { verifyCode } : {}),
    });
    $("qr-status").textContent =
      {
        wait: "等待手机扫码",
        scaned: "已扫码，等待微信确认",
        expired: "二维码已过期，请重新获取",
        need_verifycode: "需要输入微信显示的验证码",
        verify_code_blocked: "验证码错误过多，请重新扫码",
        scaned_but_redirect: "正在继续扫码验证",
        binded_redirect: "该助手已绑定，请检查微信端",
        local_confirmation_required: `扫码完成。待绑定用户：${r.userId}`,
      }[r.status] ?? r.status;
    $("qr-verify").hidden = r.status !== "need_verifycode";
    if (r.status === "local_confirmation_required") {
      qrUser = r.userId;
      $("qr-confirm").hidden = false;
      return;
    }
    if (["wait", "scaned", "scaned_but_redirect"].includes(r.status))
      setTimeout(() => action(() => pollQr()), 2000);
  } finally {
    qrPolling = false;
  }
}
$("wechat-login").onclick = () =>
  action(async () => {
    if (qrPolling) throw new Error("正在等待扫码状态，请稍后");
    qr = await api("wechat/login", {});
    $("qr-image").src = qr.image;
    $("qr-panel").hidden = false;
    $("qr-confirm").hidden = true;
    $("qr-status").textContent = "请用微信扫码";
    void action(() => pollQr());
  });
$("qr-verify").onclick = () =>
  action(async () => {
    const code = prompt("输入微信显示的验证码");
    if (code) await pollQr(code);
  });
$("qr-confirm").onclick = () =>
  action(async () => {
    if (confirm(`确认绑定用户 ${qrUser} 并允许其控制已授权项目？`)) {
      await api("wechat/bind", { userId: qrUser, confirm: "本机确认" });
      $("qr-panel").hidden = true;
      message("绑定完成，请在微信发送 /help");
    }
  });
(async () => {
  try {
    token = (await api("bootstrap")).csrf;
    await refresh();
    setInterval(() => refresh().catch((e) => message(e.message, true)), 5000);
  } catch (e) {
    message(e.message, true);
  }
})();
