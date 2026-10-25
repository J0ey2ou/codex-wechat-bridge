import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/src/ui", { recursive: true });
cpSync("src/ui", "dist/src/ui", { recursive: true });
