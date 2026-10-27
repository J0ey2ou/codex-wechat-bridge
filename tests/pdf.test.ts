import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";
import { PdfReports, renderPdf, wantsPdf } from "../src/reports/pdf.js";
import {
  ILinkAdapter,
  DeliveryUncertainError,
  trustedUpload,
} from "../src/channels/wechat/ilink.js";
import { MemoryVault } from "../src/security/vault.js";
import { Store } from "../src/storage/store.js";
import { fixture } from "./helpers.js";
import type { Delivery } from "../src/app/types.js";

test("PDF requires explicit document request, not a default, negation or development example", () => {
  for (const s of [
    "把这次结果整理成PDF报告发我",
    "给我出个 PDF 报告",
    "完成后发一份pdf",
  ])
    assert.equal(wantsPdf(s), true, s);
  for (const s of [
    "你好",
    "不要PDF，直接文字",
    "开发发送PDF的能力",
    "实现PDF报告发送功能，如果用户要求出个pdf报告也可以发过来",
  ])
    assert.equal(wantsPdf(s), false, s);
});
test("Chinese report embeds a font, paginates and generates a standalone artifact", async () => {
  const bytes = await renderPdf(
    "鲁滨逊 · 中文报告验证",
    "原对话续接与文件传输\n这份报告验证中文、数字 6.1 和 English 的连续排版。\n\n" +
      Array.from(
        { length: 50 },
        (_, n) =>
          `验证项 ${n + 1}：每份报告属于当前用户，默认仍回复文字。明确要求 PDF 时再生成；未验证的投递不会宣称已收到。`,
      ).join("\n"),
  );
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.ok(bytes.includes(Buffer.from("/FontFile3")));
  assert.ok(bytes.length < 10 * 1024 * 1024);
  mkdirSync("test-output/pdf", { recursive: true });
  writeFileSync("test-output/pdf/中文报告验证.pdf", bytes);
});
test("PDF intent, durable outbox order, dedupe, restart and user isolation", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const reports = new PdfReports(
    f.store,
    f.notices,
    mkdtempSync(path.join(tmpdir(), "pdf-report-")),
  );
  // Dispatcher uses the same report manager through its public methods for the explicit decision.
  Object.assign(f.dispatcher, { reports });
  const sent: string[] = [];
  f.channel.sendMessage = async (_u, text) => {
    sent.push(text);
    return { status: "server_accepted", clientVisible: false };
  };
  Object.assign(f.channel, {
    sendFile: async (_u: string, file: { name: string; bytes: Buffer }) => {
      sent.push(file.name);
      return { status: "server_accepted", clientVisible: false };
    },
  });
  await f.router.receive({
    id: "pdf-request",
    userId: "owner",
    text: "把这次方案整理成PDF报告发我",
    kind: "direct",
    sentAt: Date.now(),
  });
  const q = await f.decide("pdf-request", {
    action: "pdf_report",
    reply: "",
    report: { title: "方案报告", body: "已核实的内容。\n未核实的限制仍保留。" },
  });
  assert.equal(q.status, "completed");
  assert.match(q.replyText!, /正在发送/);
  await f.notices.flush();
  await f.notices.flush();
  assert.deepEqual(sent, ["PDF 整理好了，正在发送。", "方案报告.pdf"]);
  const report = reports.list("owner")[0]!;
  const again = await reports.create(
    "owner",
    "pdf-request",
    "不同的标题",
    "不会重复生成",
  );
  assert.equal(again.id, report.id);
  reports.enqueue(again, "pdf-request");
  await f.notices.flush();
  assert.equal(sent.length, 2);
  const restored = new PdfReports(f.store, f.notices, f.config.dataDir);
  assert.equal(restored.list("owner").length, 1);
  f.store.setSetting("boundUser", "other");
  assert.deepEqual(restored.list("other"), []);
  assert.throws(() => reports.read(report.id, "other"), /找不到/);
  assert.throws(() => reports.read(report.id, "owner"), /绑定用户/);
});

test("task PDF publishes once and a failed queue transaction can safely resume", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const reports = new PdfReports(
    f.store,
    f.notices,
    mkdtempSync(path.join(tmpdir(), "task-pdf-")),
  );
  const task = f.tasks.create(f.project.id, "完成后给我PDF报告");
  task.pdfRequested = true;
  task.status = "COMPLETED";
  task.summary = "实际完成的结果；未验证项仍待确认。";
  f.store.put("tasks", task);
  const original = f.notices.enqueue.bind(f.notices);
  f.notices.enqueue = () => {
    throw new Error("simulated queue failure");
  };
  await assert.rejects(reports.task(task), /queue failure/);
  assert.equal(f.store.get<any>("tasks", task.id).pdfReportId, undefined);
  f.notices.enqueue = original;
  await reports.task(task);
  await reports.task(task);
  assert.ok(f.store.get<any>("tasks", task.id).pdfReportId);
  assert.equal(reports.list("owner").length, 1);
  assert.equal(
    f.store.all<Delivery>("notification_deliveries").filter((d) => d.documentId)
      .length,
    1,
  );
});

function adapter(fetcher: typeof fetch) {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "owner");
  const channel = new ILinkAdapter(store, new MemoryVault(), fetcher);
  // Inject fake credentials only; don't connect/poll the real service.
  Object.assign(channel, {
    state: "CONNECTED",
    credentials: {
      userId: "owner",
      token: "fake-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      botId: "fake",
    },
    contexts: { owner: { token: "fake-context", updatedAt: Date.now() } },
  });
  return { store, channel };
}
test("Tencent native FILE=4 upload encrypts bytes and sends hex-base64 key without CDN auth", async (t) => {
  let aes = "",
    uploaded: Buffer | undefined,
    envelope: any;
  const plain = Buffer.from("%PDF-1.7\nfake fixture\n%%EOF");
  const f = adapter((async (input, init) => {
    const url = String(input);
    if (url.endsWith("getuploadurl")) {
      const b = JSON.parse(String(init!.body));
      aes = b.aeskey;
      assert.equal(b.media_type, 3);
      assert.equal(b.rawfilemd5, createHash("md5").update(plain).digest("hex"));
      return Response.json({ ret: 0, upload_param: "upload-query" });
    }
    if (url.includes("/c2c/upload")) {
      assert.deepEqual(init!.headers, {
        "Content-Type": "application/octet-stream",
      });
      assert.equal(init!.redirect, "error");
      uploaded = Buffer.from(init!.body as Uint8Array);
      return new Response(null, {
        status: 200,
        headers: { "x-encrypted-param": "download-query" },
      });
    }
    envelope = JSON.parse(String(init!.body));
    return Response.json({ ret: 0 });
  }) as typeof fetch);
  t.after(() => f.store.close());
  const result = await f.channel.sendFile(
    "owner",
    { name: "中文报告.pdf", bytes: plain },
    "stable-id",
  );
  assert.equal(result.status, "server_accepted");
  assert.equal(result.clientVisible, false);
  const d = createDecipheriv("aes-128-ecb", Buffer.from(aes, "hex"), null);
  assert.deepEqual(Buffer.concat([d.update(uploaded!), d.final()]), plain);
  const item = envelope.msg.item_list[0];
  assert.equal(item.type, 4);
  assert.equal(
    Buffer.from(item.file_item.media.aes_key, "base64").toString(),
    aes,
  );
  assert.equal(item.file_item.len, String(plain.length));
  assert.equal(envelope.msg.client_id, "stable-id");
});
test("file upload rejects foreign CDN and rebind; ambiguous send never automatically retries", async (t) => {
  assert.throws(
    () => trustedUpload("https://evil.example/c2c/upload"),
    /不受信任/,
  );
  const f = adapter((async (input) => {
    if (String(input).endsWith("getuploadurl"))
      return Response.json({ upload_param: "query" });
    if (String(input).includes("/c2c/upload"))
      return new Response(null, { headers: { "x-encrypted-param": "param" } });
    throw new Error("network timeout");
  }) as typeof fetch);
  t.after(() => f.store.close());
  await assert.rejects(
    f.channel.sendFile(
      "owner",
      { name: "r.pdf", bytes: Buffer.from("%PDF-1.7") },
      "x",
    ),
    DeliveryUncertainError,
  );
  await assert.rejects(
    f.channel.sendFile(
      "other",
      { name: "r.pdf", bytes: Buffer.from("%PDF-1.7") },
      "x",
    ),
    /绑定用户/,
  );
  const g = await fixture();
  t.after(() => g.store.close());
  let calls = 0;
  Object.assign(g.channel, {
    sendFile: async () => {
      calls++;
      throw new DeliveryUncertainError("unknown");
    },
  });
  g.notices.documentReader = () => ({
    name: "r.pdf",
    bytes: Buffer.from("%PDF-1.7"),
  });
  g.notices.enqueue("PDF", "pdf:test", "owner", "reply", undefined, {
    documentId: "test",
  });
  await g.notices.flush();
  await g.notices.flush(Date.now() + 600000);
  assert.equal(calls, 1);
  assert.equal(
    g.store.all<Delivery>("notification_deliveries").find((d) => d.documentId)
      ?.status,
    "delivery_unverified",
  );
});
