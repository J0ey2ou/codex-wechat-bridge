let token = "",
  state,
  qr,
  qrUser,
  activePage = "home",
  settingsLoaded = false,
  qrPolling = false;
let memoryLoadedFor,
  installPrompt,
  pushSettingDirty = false;
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
function desktopActivityRow(t) {
  const labels = {
    pending: "等待核对",
    running: "执行中",
    waiting: "等待操作",
    recentActivity: "有活动 · 运行待确认",
    unconfirmed: "状态待确认",
    completed: "已完成",
    failed: "执行失败",
    interrupted: "已中断",
    idle: "暂无执行",
  };
  const r = row(
    t.name,
    t.status === "pending"
      ? "等待核对"
      : t.stale
        ? "状态待刷新"
        : (labels[t.status] ?? "状态待确认"),
    `${t.projectName} · Codex 对话 · 最近更新 ${date(t.updatedAt)}\n${t.evidence}`,
  );
  r.append(
    button("查看状态依据", () => {
      $("detail-content").replaceChildren(
        el("h2", t.name),
        el(
          "pre",
          `原对话 ID：${t.id}\n项目：${t.projectName}\n工作目录：${t.cwd}\n最近轮次：${t.turnId ?? "未报告"}\n观察状态：${t.runtimeStatus}\n轮次状态：${t.turnStatus ?? "未报告"}\n开始：${date(t.startedAt)}\n结束：${date(t.completedAt)}\n核对时间：${date(t.checkedAt)}\n依据：${t.evidence}\n会话配置模型：${t.configuredModel ?? "未报告"}\n实际执行模型：未报告\n\n${t.summary ?? "完整进展请在原 Codex 对话查看。"}${t.error ? "\n读取问题：" + t.error : ""}`,
        ),
      );
      $("detail").showModal();
    }),
  );
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
  $("runtime-build").textContent =
    `正在运行的构建：${state.build?.id ?? "旧构建"} · ${state.runtime?.managed ? "EXE 托管后台" : "独立服务"}${state.runtime?.bundledCodex ? " · 内置 Codex" : ""}`;
  list("pdf-reports", state.reports ?? [], (r) => {
    const item = row(
      r.name,
      "已生成",
      `${date(r.createdAt)} · ${Math.ceil(r.bytes / 1024)} KB`,
    );
    item.append(
      button("下载 PDF", async () => {
        const response = await fetch("/api/reports/download", {
          method: "POST",
          headers: {
            "X-Bridge-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id: r.id }),
        });
        if (!response.ok)
          throw new Error((await response.json()).error ?? "下载失败");
        const url = URL.createObjectURL(await response.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = r.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
    );
    return item;
  });
  const pushEnabled = state.settings.wechatPushEnabled !== false;
  if (!pushSettingDirty)
    $("settings-form").elements.wechatPushEnabled.checked = pushEnabled;
  $("wechat-push-toggle").textContent =
    `微信推送：${pushEnabled ? "开启" : "已关闭"}`;
  $("wechat-push-toggle").setAttribute("aria-checked", String(pushEnabled));
  $("wechat-push-toggle").title = pushEnabled
    ? "关闭微信主动提醒"
    : "开启微信主动提醒";
  const open = state.tasks.filter(isOpen);
  const activity = state.desktopActivity;
  const external = activity?.threads ?? [];
  $("desktop-activity-status").textContent = activity
    ? `每 ${activity.intervalMs / 1000} 秒核对，最近成功 ${date(activity.lastSuccessAt)}。${activity.error ?? (activity.status === "disconnected" ? "Codex 连接中断，保留记录供查看。" : activity.status === "waitingForBinding" ? "绑定用户后开始观察。" : "其他客户端的实时运行状态可能不可用；有活动不等于已确认执行中。")}${activity.paginationComplete ? "" : " 正在分页发现更多对话。"}`
    : "当前后台尚未提供对话观察，请确认新版后台已启动。";
  list("desktop-activity", external.slice(0, 6), desktopActivityRow);
  list("desktop-task-list", external, desktopActivityRow);
  $("desktop-activity-refresh").onclick = () =>
    action(() => api("activity/refresh", {}));
  const cards = [
    [
      "微信通道",
      state.connections.wechat,
      state.boundUser ? "已绑定用户" : "等待扫码与本机确认",
    ],
    [
      "Codex",
      state.connections.codex ? "已连接服务" : "未连接",
      state.modes.codex === "mock" ? "MOCK · 模拟模式" : "官方 App Server",
    ],
    ["Bridge 未结束任务", String(open.length), "含排队、执行和待核实状态"],
    [
      "Codex 对话",
      `${activity?.running ?? 0} 已确认执行 · ${activity?.recentActivity ?? 0} 有活动`,
      `${activity?.waiting ?? 0} 等待操作 · ${activity?.unconfirmed ?? 0} 运行状态待确认；不重复计入 Bridge 任务`,
    ],
    ["待处理审批", String(state.approvals.length), "每次批准均绑定唯一编号"],
    [
      "完成通知",
      !pushEnabled
        ? "微信推送已关闭"
        : state.desktopCompletion?.error
          ? "暂时无法读取"
          : state.desktopCompletion?.status === "watching"
            ? "后台关注中"
            : "等待连接就绪",
      "Codex 会话有新结果时提醒；完整结果保留在电脑上",
    ],
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
  list("discovered-workspaces", state.availableProjects ?? [], (project) =>
    row(
      project.name,
      project.workspaceIds.length ? "可用" : "目录暂不可用",
      project.workspaceIds.length > 1
        ? `${project.workspaceIds.length} 个工作目录`
        : "",
    ),
  );
  const latencyNames = {
    ingress: "接收入库",
    routing: "路由",
    queue: "问答排队",
    preparation: "会话准备",
    modelRound: "模型轮次",
    dispatch: "动作处理",
    sendQueue: "发送排队",
    sendRequest: "发送请求",
    receipt: "接收到回执发出",
  };
  $("message-latency").textContent = Object.entries(latencyNames)
    .map(([key, label]) => {
      const metric = state.messageLatency?.[key];
      return metric?.samples
        ? `${label}：中位 ${metric.medianMs} ms / P95 ${metric.p95Ms} ms（${metric.samples} 条）`
        : `${label}：尚无成对时间戳`;
    })
    .join("\n");
  $("notification-report").onclick = async () => {
    try {
      const report = await api("notification-report");
      $("detail-content").replaceChildren(
        el("h2", "对话、通知优化与当前生效状态"),
        el("pre", report.text),
      );
      $("detail").showModal();
    } catch (error) {
      message(error.message, true);
    }
  };
  $("project-issues").onclick = async () => {
    try {
      const report = await api("project-issues");
      $("detail-content").replaceChildren(
        el("h2", "项目问题记录"),
        el("pre", report.text),
      );
      $("detail").showModal();
    } catch (error) {
      message(error.message, true);
    }
  };
  list("routing-requests", state.routingRequests ?? [], (request) => {
    const task = state.tasks.find((t) => t.id === request.taskId);
    const status =
      request.state === "blocked"
        ? "目标待处理"
        : task?.targetResumedAt
          ? "已恢复指定对话"
          : request.state === "dispatched"
            ? "已选定，尚未确认进入"
            : "等待补充目标";
    const item = row(
      `${request.projectName ?? "项目待明确"} · ${request.threadName ?? "对话待明确"}`,
      status,
      request.lastReply,
    );
    item.append(
      button("原要求、澄清与真实目标", () => {
        $("detail-content").replaceChildren(
          el("h2", "目标绑定详情"),
          el(
            "pre",
            JSON.stringify(
              {
                request,
                execution: task && {
                  taskId: task.id,
                  selectedThreadId: task.targetThreadId,
                  actualThreadId: task.threadId,
                  resumedAt: task.targetResumedAt,
                  turnId: task.turnId,
                  status: task.status,
                  waiting: task.targetWaitReason,
                },
              },
              null,
              2,
            ),
          ),
        );
        $("detail").showModal();
      }),
    );
    return item;
  });
  list("message-analysis", (state.messageAnalysis ?? []).slice(0, 20), (q) => {
    const item = row(
      q.text,
      {
        queued: "等待理解",
        running: "正在理解",
        dispatching: "正在处理",
        completed: "回复已生成",
        failed: "未完成",
      }[q.status] ?? q.status,
      q.status === "failed"
        ? `${q.answer ?? ""}\n${q.error ?? ""}`
        : q.status === "completed"
          ? (q.replyText ?? q.answer)
          : "Codex 正在分析你的消息。",
    );
    item.append(
      button("完整要求与处理详情", () => {
        $("detail-content").replaceChildren(
          el("h2", "消息详情"),
          el("pre", JSON.stringify(q, null, 2)),
        );
        $("detail").showModal();
      }),
    );
    return item;
  });
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
  list("delivery-list", state.deliveries, (d) => {
    const item = row(
      d.text.slice(0, 100),
      d.status === "suppressed" ? "仅在软件内保留" : d.status,
      d.status === "suppressed"
        ? `${date(d.createdAt)} · ${d.error ?? "仅留在软件后台，未发送"}`
        : `${date(d.createdAt)} · 尝试 ${d.attempts} 次 · 手机可见性未验证${d.error ? "\n" + d.error : ""}`,
    );
    item.append(
      button("查看后台详情", () => {
        $("detail-content").replaceChildren(
          el("h2", "通知详情"),
          el("pre", JSON.stringify(d, null, 2)),
        );
        $("detail").showModal();
      }),
    );
    return item;
  });
  const selected = $("task-project").value;
  const available =
    state.availableProjects?.filter((p) => p.workspaceIds.length) ??
    state.projects;
  $("task-project").replaceChildren(
    ...available.map((p) => {
      const o = el("option", p.name);
      o.value = p.id;
      return o;
    }),
  );
  if (available.some((p) => p.id === selected))
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
          const r = row(
            s.name,
            typeof s.status === "string"
              ? s.status
              : (s.status?.type ?? "unknown"),
            s.id,
          );
          r.append(
            button("查看并续接原对话", async () => {
              const inspected = await api("sessions/inspect", {
                projectId: p.id,
                threadId: s.id,
              });
              const panel = el("div");
              panel.append(el("pre", JSON.stringify(inspected, null, 2)));
              const taskInput = el("textarea");
              taskInput.placeholder = "核对最新对话后，填写要继续处理的要求";
              taskInput.maxLength = 8000;
              const modelInput = el("input");
              modelInput.placeholder = "可选模型，如 6.1sol";
              modelInput.value = p.requestedModel ?? "";
              let submission;
              panel.append(
                taskInput,
                modelInput,
                button("在原对话继续", async () => {
                  if (!taskInput.value.trim())
                    throw new Error("请填写要继续处理的要求");
                  // Keep identical payload/key on retry after an uncertain HTTP response.
                  submission ??= {
                    requestId: crypto.randomUUID(),
                    projectId: p.id,
                    threadId: s.id,
                    text: taskInput.value,
                    model: modelInput.value || undefined,
                    expectedHistoryRevision: inspected.historyRevision,
                  };
                  taskInput.disabled = modelInput.disabled = true;
                  const result = await api("sessions/continue", submission);
                  message(result.note);
                }),
              );
              r.append(panel);
            }),
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
        "移除会话记录",
        async () => {
          if (
            confirm(
              "移除这条项目执行记录？不会删除文件，也不会从 Codex 项目列表删除。",
            )
          )
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
  $("setup-status").textContent =
    `${state.boundUser ? "微信已绑定" : "微信未绑定"} · ${state.modes.codex === "mock" ? "AI 模拟模式" : "OpenAI 登录需官方检查"}`;
  if (state.connections.codex) {
    try {
      renderAuth(await api("openai/status"));
    } catch {
      $("openai-status").textContent = "登录状态暂时无法核实，请检查连接。";
    }
  }
  if (activePage === "memory") await loadMemory();
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
        tasks: "任务",
        todos: "待办与提醒",
        projects: "项目",
        memory: "个性与记忆",
        usage: "模型与用量",
        settings: "连接与设置",
      }[activePage];
      if (activePage === "memory") action(loadMemory);
      if (activePage === "usage") action(loadEvidence);
    }),
);
form("project-form", async (data, f) => {
  await api("projects/add", data);
  f.reset();
  message("项目已添加");
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
  if (pushSettingDirty)
    data.wechatPushEnabled = f.elements.wechatPushEnabled.checked;
  else delete data.wechatPushEnabled;
  data.autoContinueLowRisk = f.elements.autoContinueLowRisk.checked;
  await api("settings", data);
  pushSettingDirty = false;
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
$("settings-form").elements.wechatPushEnabled.onchange = () => {
  pushSettingDirty = true;
};
$("wechat-push-toggle").onclick = () =>
  action(async () => {
    const enabled = state.settings.wechatPushEnabled === false;
    $("wechat-push-toggle").disabled = true;
    try {
      await api("settings", { wechatPushEnabled: enabled });
      pushSettingDirty = false;
      $("settings-form").elements.wechatPushEnabled.checked = enabled;
      message(
        enabled
          ? "微信推送已开启，只提醒之后的新消息。"
          : "微信推送已关闭，结果会保留在软件里。",
      );
    } finally {
      $("wechat-push-toggle").disabled = false;
    }
  });
$("detail-close").onclick = () => $("detail").close();
$("codex-check").onclick = () =>
  action(async () => {
    $("codex-result").textContent = JSON.stringify(
      await api("codex/check", {}),
      null,
      2,
    );
  });
$("setup-open").onclick = () =>
  document.querySelector('[data-page="settings"]').click();
const billingNames = {
  "chatgpt-plan": "ChatGPT / Codex 套餐权益",
  "openai-api": "OpenAI Platform API 计费",
  mock: "模拟模式，无真实消耗",
  unknown: "来源未核实",
};
function renderAuth(a) {
  $("openai-status").textContent =
    `${a.accountType ? "已登录：" + a.accountType : "尚未登录"} · ${billingNames[a.billingSource]}${a.planType ? " · " + a.planType : ""}${a.pending ? " · 等待官方登录完成" : ""}`;
  $("setup-status").textContent =
    `${state.boundUser ? "微信已绑定" : "微信未绑定"} · ${a.accountType ? "OpenAI：" + a.accountType : "OpenAI 未登录"}`;
  if (!a.pending) {
    $("openai-link").hidden = true;
    $("openai-link").removeAttribute("href");
  }
}
$("openai-login").onclick = () =>
  action(async () => {
    const b = $("openai-login");
    b.disabled = true;
    try {
      const login = await api("openai/login", {});
      $("openai-link").href = login.url;
      $("openai-link").hidden = false;
      message("点击官方登录链接完成验证，再回到鲁滨逊。登录状态会自动更新。");
    } finally {
      b.disabled = false;
    }
  });
$("openai-cancel").onclick = () =>
  action(async () => {
    await api("openai/cancel", {});
    $("openai-link").hidden = true;
  });
$("openai-logout").onclick = () =>
  action(async () => {
    if (
      confirm(
        "退出此 Codex 环境的 OpenAI 登录？共用该环境的 Codex CLI 也会退出。",
      )
    )
      await api("openai/logout", {});
  });
$("usage-refresh").onclick = () =>
  action(async () => {
    $("usage-result").textContent = "正在通过 Bridge 查询官方接口…";
    try {
      const r = await api("openai/usage", {});
      $("usage-result").textContent =
        `${billingNames[r.account.billingSource]}\n查询时间：${date(r.checkedAt)}\n${r.limits}`;
    } catch (e) {
      $("usage-result").textContent = `查询失败，无法确认余额：${e.message}`;
    }
  });
async function loadEvidence() {
  const r = await api("evidence");
  list("evidence-list", r.records, (e) =>
    row(
      e.route === "wechat-entry"
        ? "微信入口问答"
        : e.route === "project-execution"
          ? "项目执行"
          : "未知调用路径",
      e.status,
      `${date(e.startedAt)}\n轮次：${e.turnId}\n实际模型：${e.actualModel ?? "未报告"}\n会话配置模型：${e.threadModel ?? "未报告"}\n额度来源：${billingNames[e.billingSource] ?? "未核实"}\n本轮 token：${e.tokens?.totalTokens ?? "未报告"}`,
    ),
  );
}
$("evidence-refresh").onclick = () => action(loadEvidence);
async function loadMemory() {
  const user = state.boundUser;
  for (const id of ["memory-settings", "memory-form"])
    for (const input of $(id).elements) input.disabled = !user;
  if (!user) {
    $("memory-status").textContent = "绑定微信后即可管理你的个人记忆。";
    $("memory-list").replaceChildren();
    memoryLoadedFor = undefined;
    return;
  }
  const data = await api("memory");
  if (state.boundUser !== user) return;
  const p = data.profile;
  $("memory-status").textContent =
    `已学习 ${p.exchanges} 次交流 · 简洁反馈 ${p.briefSignals} 次 / 详细反馈 ${p.detailedSignals} 次 · ${data.memories.length}/50 条记忆。达到 3 次同向反馈后形成详略倾向，手动选择优先。`;
  if (data.effectiveVoice) {
    const voice = data.effectiveVoice;
    $("memory-status").textContent +=
      ` 当前生效：${{ natural: "自然", warm: "温和", direct: "直接" }[voice.tone]} · ${{ adaptive: "按话题调整长度", brief: "简短", detailed: "需要时详说" }[voice.detail]}；闲聊仍以单段回复，不增加润色调用。`;
  }
  if (memoryLoadedFor !== user) {
    const f = $("memory-settings");
    f.elements.enabled.checked = p.enabled;
    f.elements.learnStyle.checked = p.learnStyle;
    f.elements.tone.value = p.tone;
    f.elements.detail.value = p.detail;
    memoryLoadedFor = user;
  }
  list("memory-list", data.memories, (m) => {
    const r = row(
      m.text,
      m.source === "explicit" ? "你让我记住的" : "手动保存",
      date(m.updatedAt),
    );
    const actions = el("div", undefined, "actions");
    actions.append(
      button("编辑", async () => {
        const text = prompt("修改这条记忆（最多 800 字）", m.text);
        if (text !== null) await api("memory/save", { id: m.id, text });
      }),
      button(
        "删除",
        async () => {
          if (confirm("删除这条记忆，并开始新的问答上下文？"))
            await api("memory/delete", { id: m.id });
        },
        "danger",
      ),
    );
    r.append(actions);
    return r;
  });
}
form("memory-settings", async (data, f) => {
  await api("memory/settings", {
    enabled: f.elements.enabled.checked,
    learnStyle: f.elements.learnStyle.checked,
    tone: data.tone,
    detail: data.detail,
  });
  memoryLoadedFor = undefined;
  message("偏好已保存，下次对话使用新的上下文。");
});
form("memory-form", async (data, f) => {
  await api("memory/save", { text: data.text });
  f.reset();
  message("记忆已保存。");
});
for (const [id, history] of [
  ["memory-clear", false],
  ["history-clear", true],
])
  $(id).onclick = () =>
    action(async () => {
      if (
        confirm(
          history
            ? "清空你的记忆、学习到的风格及本地对话记录？官方 Codex 副本不受影响。"
            : "清空你的长期记忆与学习到的风格？",
        )
      ) {
        await api("memory/clear", { confirm: "清空我的记忆", history });
        memoryLoadedFor = undefined;
        message("已清空，下次对话从新的上下文开始。");
      }
    });
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("install-app").hidden = false;
});
$("install-app").onclick = async () => {
  if (installPrompt) {
    await installPrompt.prompt();
    installPrompt = undefined;
    $("install-app").hidden = true;
  }
};
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
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
    if (
      confirm(
        `确认绑定用户 ${qrUser}？绑定后可查询软件数据、打开应用，并在项目内执行读写任务；后续无需逐项目授权。`,
      )
    ) {
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
