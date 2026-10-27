import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { localReport } from "../src/reports/local.js";
test("installation evidence is optional and scoped to its bound owner", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "local-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = path.join(
    root,
    "project-reports",
    createHash("sha256").update("owner-a").digest("hex"),
  );
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "project-issues.txt"), "private evidence");
  assert.equal(
    localReport(root, "owner-a", "project-issues"),
    "private evidence",
  );
  assert.equal(localReport(root, "owner-b", "project-issues"), "");
  assert.equal(localReport(root, "", "project-issues"), "");
  assert.equal(localReport(root, "owner-a", "notification-report"), "");
});
