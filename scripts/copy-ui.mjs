import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
mkdirSync("dist/src/ui", { recursive: true });
cpSync("src/ui", "dist/src/ui", { recursive: true });
const hash = createHash("sha256");
function add(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) add(file);
    else if (!file.endsWith(".map") && item.name !== "build-info.json")
      hash.update(file.replaceAll("\\", "/")).update(readFileSync(file));
  }
}
add("dist/src");
add("scripts");
add("packaging");
add("assets");
hash.update(readFileSync("package-lock.json"));
writeFileSync(
  "dist/src/build-info.json",
  JSON.stringify({
    id: hash.digest("hex").slice(0, 16),
    createdAt: new Date().toISOString(),
  }) + "\n",
);
