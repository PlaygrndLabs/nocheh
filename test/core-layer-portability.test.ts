import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture guard: the core layers must stay runtime-neutral.
 *
 * `domain/` and `application/` hold the business logic and ports. They must not
 * import Node.js built-ins (`node:*`), so the same code can run unchanged inside
 * a constrained V8 isolate (e.g. Telegram Serverless) where only an SDK is
 * available. Node-specific concerns belong in `infrastructure/` and
 * `interfaces/` adapters behind ports.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(testDir, "..", "..", "src");

const NODE_IMPORT = /(?:\bfrom\b|\bimport\b|\brequire\s*\()\s*["']node:[\w./-]+["']/;

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function offendingFiles(layer: string): string[] {
  return collectTsFiles(join(srcDir, layer))
    .filter((file) => NODE_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(srcDir.length + 1));
}

test("domain layer imports no node: built-ins (stays isolate-portable)", () => {
  assert.deepEqual(
    offendingFiles("domain"),
    [],
    "domain/ must not import node:* built-ins; move Node concerns behind a port.",
  );
});

test("application layer imports no node: built-ins (stays isolate-portable)", () => {
  assert.deepEqual(
    offendingFiles("application"),
    [],
    "application/ must not import node:* built-ins; inject a port instead (e.g. IdGeneratorPort).",
  );
});
