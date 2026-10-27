import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Deliberately does not import main.js, create a Bridge, start a server or log in.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportFile = process.argv[2] && path.resolve(process.argv[2]);
const checks = [];
const report = {
  ok: false,
  node: process.version,
  executable: process.execPath,
  arch: process.arch,
  checks,
};
try {
  assert.ok(reportFile, "A report path is required");
  assert.equal(process.env.ROBINSON_PACKAGED, "1");
  assert.equal(process.arch, "x64");
  const expectedNode = path.join(app, "..", "runtime", "node.exe");
  assert.equal(
    realpathSync(process.execPath).toLowerCase(),
    realpathSync(expectedNode).toLowerCase(),
  );
  checks.push("private Node runtime");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('portable sqlite');",
    );
    assert.equal(
      database.prepare("SELECT value FROM probe").get().value,
      "portable sqlite",
    );
  } finally {
    database.close();
  }
  checks.push("built-in SQLite in-memory read/write");
  const { DateTime } = await import("luxon");
  assert.equal(
    DateTime.fromISO("2026-01-01T00:00:00", { zone: "Asia/Shanghai" }).isValid,
    true,
  );
  const { default: QRCode } = await import("qrcode");
  assert.ok(
    (await QRCode.toString("portable self-test", { type: "svg" })).includes(
      "<svg",
    ),
  );
  checks.push("production modules and QR rendering");
  const { Bridge } = await import("../dist/src/app/bridge.js");
  const { createApi } = await import("../dist/src/api/server.js");
  assert.equal(typeof Bridge, "function");
  assert.equal(typeof createApi, "function");
  checks.push("compiled application imports without starting services");
  const { renderPdf } = await import("../dist/src/reports/pdf.js");
  const pdf = await renderPdf(
    "独立运行验证",
    "中文 PDF 报告由内置运行环境生成，无需安装 Python 或 Node。",
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  checks.push("Chinese PDF with bundled font");
  const codex = path.join(app, "../runtime/codex/codex.exe");
  report.codexVersion = execFileSync(codex, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  }).trim();
  checks.push("bundled official Codex executable");
  report.build = JSON.parse(
    readFileSync(path.join(app, "dist/src/build-info.json"), "utf8"),
  ).id;
  const metadata = JSON.parse(
    readFileSync(path.join(app, "package.json"), "utf8"),
  );
  assert.equal(metadata.type, "module");
  report.version = metadata.version;
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (reportFile) {
    try {
      mkdirSync(path.dirname(reportFile), { recursive: true });
      writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch (error) {
      console.error("Cannot write the self-test report:", error.message);
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(report));
}
