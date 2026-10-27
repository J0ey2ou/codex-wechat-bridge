import { readFileSync } from "node:fs";
export const BUILD: { id: string; createdAt?: string } = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("../build-info.json", import.meta.url), "utf8"),
    );
  } catch {
    return { id: "development-unbuilt" };
  }
})();
