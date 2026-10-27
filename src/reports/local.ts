import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

type ReportName =
  | "runtime-upgrade-report"
  | "project-issues"
  | "notification-report";
/** Installation-specific incident evidence stays in ignored, owner-scoped data. */
export function localReport(
  dataDir: string,
  owner: string,
  name: ReportName,
): string {
  if (!owner) return "";
  const hash = createHash("sha256").update(owner).digest("hex");
  try {
    return readFileSync(
      path.join(dataDir, "project-reports", hash, name + ".txt"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
