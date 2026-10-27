import PDFDocument from "pdfkit";
import type { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "../storage/store.js";
import type { NotificationManager } from "../notifications/outbox.js";
import type { Task } from "../app/types.js";
import { safeText, within } from "../security/policy.js";

export const PDF_LIMIT = 10 * 1024 * 1024;
export const PDF_FONT = fileURLToPath(
  new URL("../../../assets/fonts/NotoSansCJKsc-Regular.otf", import.meta.url),
);
export interface PdfReport {
  id: string;
  userId: string;
  name: string;
  title: string;
  createdAt: number;
  bytes: number;
  sha256: string;
  sourceId: string;
}
const digest = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

/** Additional delivery guard; the intent decision still supplies the semantics. */
export function wantsPdf(text: string) {
  if (
    !/pdf/i.test(text) ||
    /(?:不要|不用|无需|别|不需要)[^。！？\n]{0,16}pdf/i.test(text)
  )
    return false;
  // Quoted development requirements are not an instruction to send a document now.
  if (
    /(?:增加|开发|实现|支持|优化|修复)[^。！？\n]{0,35}(?:pdf|报告发送|文件传输|传输pdf)/i.test(
      text,
    )
  )
    return false;
  return /(?:生成|整理|写|出|做|发|给|导出|转成|提供)[^。！？\n]{0,28}pdf|pdf[^。！？\n]{0,18}(?:发我|给我|报告|一份)/i.test(
    text,
  );
}
export async function renderPdf(title: string, body: string): Promise<Buffer> {
  title = safeText(title, 120).trim();
  body = safeText(body, 50000).trim();
  if (!title || !body) throw new Error("PDF 需要标题和正文");
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: title,
      Author: "鲁滨逊 · AI 助手",
      Creator: "Robinson PDF report",
    },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    doc.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PDF_LIMIT)
        (doc as unknown as Readable).destroy(
          new Error("PDF 超过 10 MB 本地发送限制"),
        );
      else chunks.push(chunk);
    });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  // Plain text only: no model-authored HTML, scripts, remote fonts, links or file reads.
  try {
    doc
      .font(PDF_FONT)
      .fontSize(20)
      .fillColor("#183C36")
      .text(title, { lineGap: 5 });
    doc
      .moveDown(0.6)
      .fontSize(9)
      .fillColor("#60706B")
      .text("鲁滨逊 · 报告", { lineGap: 3 });
    doc.moveDown(1).fontSize(11).fillColor("#202C28");
    for (const paragraph of body.replace(/\r\n?/g, "\n").split(/\n+/)) {
      const line = paragraph
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1");
      if (line) doc.text(line, { lineGap: 5, paragraphGap: 9 });
    }
    const pages = doc.bufferedPageRange();
    for (let n = 0; n < pages.count; n++) {
      doc.switchToPage(n);
      doc.fontSize(8).fillColor("#60706B");
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.text(`${n + 1} / ${pages.count}`, 54, doc.page.height - 36, {
        width: doc.page.width - 108,
        align: "right",
        lineBreak: false,
      });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  } catch (error) {
    (doc as unknown as Readable).destroy(error as Error);
  }
  return result;
}

export class PdfReports {
  private pending = new Map<string, Promise<PdfReport>>();
  constructor(
    private store: Store,
    private notices: NotificationManager,
    private dataDir: string,
  ) {
    notices.documentReader = (id, userId) => this.read(id, userId);
  }
  private owner(userId: string) {
    if (!userId || userId !== this.store.setting("boundUser", ""))
      throw new Error("报告不属于当前绑定用户");
  }
  list(userId: string) {
    this.owner(userId);
    return this.store
      .all<PdfReport>("pdf_reports")
      .filter((r) => r.userId === userId);
  }
  private file(userId: string, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("无效报告编号");
    const root = path.resolve(this.dataDir);
    mkdirSync(root, { recursive: true });
    const reportRoot = path.join(root, "reports"),
      dir = path.join(reportRoot, digest(userId));
    for (const directory of [reportRoot, dir]) {
      if (
        existsSync(directory) &&
        !within(realpathSync(root), realpathSync(directory))
      )
        throw new Error("报告目录越界");
      mkdirSync(directory, { recursive: true });
      if (!within(realpathSync(root), realpathSync(directory)))
        throw new Error("报告目录越界");
    }
    return path.join(dir, id + ".pdf");
  }
  read(id: string, userId: string) {
    this.owner(userId);
    const report = this.store.get<PdfReport>("pdf_reports", id);
    if (!report || report.userId !== userId)
      throw new Error("找不到当前用户的报告");
    const file = this.file(userId, id);
    if (!within(realpathSync(path.dirname(file)), realpathSync(file)))
      throw new Error("报告文件越界");
    const bytes = readFileSync(file);
    if (
      bytes.length > PDF_LIMIT ||
      digest(bytes) !== report.sha256 ||
      bytes.subarray(0, 5).toString() !== "%PDF-"
    )
      throw new Error("报告文件校验失败，请重新生成");
    return { name: report.name, bytes };
  }
  async create(
    userId: string,
    sourceId: string,
    title: string,
    body: string,
  ): Promise<PdfReport> {
    this.owner(userId);
    const id = digest(userId + "\0" + sourceId);
    const existing = this.store.get<PdfReport>("pdf_reports", id);
    if (existing) return existing;
    const active = this.pending.get(id);
    if (active) return active;
    const work = (async () => {
      const bytes = await renderPdf(title, body);
      this.owner(userId);
      const file = this.file(userId, id);
      const temporary = file + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, bytes, { flag: "wx" });
      renameSync(temporary, file);
      const name =
        (title
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          .replace(/[. ]+$/g, "")
          .slice(0, 70) || "报告") + ".pdf";
      const report: PdfReport = {
        id,
        userId,
        name,
        title: safeText(title, 120),
        createdAt: Date.now(),
        bytes: bytes.length,
        sha256: digest(bytes),
        sourceId,
      };
      this.store.put("pdf_reports", report);
      return report;
    })();
    this.pending.set(id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(id);
    }
  }
  enqueue(report: PdfReport, messageId?: string) {
    this.owner(report.userId);
    return this.notices.enqueue(
      "PDF 报告",
      `pdf:${report.id}`,
      report.userId,
      "reply",
      undefined,
      { messageId, documentId: report.id },
    );
  }
  async task(t: Task) {
    const userId = this.store.setting("boundUser", "");
    if (
      !t.pdfRequested ||
      !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status)
    )
      return;
    const text = [
      `任务：${t.title}`,
      `状态：${t.status}`,
      t.summary || t.userMessage || "暂无结果摘要",
      t.error ? `限制：${t.error}` : "",
      t.files.length ? `文件：\n${t.files.join("\n")}` : "",
      t.tests.length ? `验证：\n${t.tests.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const report = await this.create(userId, "task:" + t.id, "任务报告", text);
    this.store.transaction(() => {
      this.enqueue(report, t.sourceMessageId);
      t.pdfReportId = report.id;
      delete t.pdfError;
      this.store.put("tasks", t);
    });
  }
}
