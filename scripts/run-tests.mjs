import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testDir = "test";
const files = readdirSync(testDir)
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .map((file) => join("dist", testDir, file.replace(/\.ts$/, ".js")));

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
