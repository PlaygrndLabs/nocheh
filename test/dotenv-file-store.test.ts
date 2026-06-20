import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DotenvFileStore } from "../src/infrastructure/config/dotenv-file-store.js";

async function tempEnvPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nocheh-env-"));
  return join(dir, ".env");
}

test("updates an existing key in place and preserves comments and blank lines", async () => {
  const path = await tempEnvPath();
  await writeFile(path, "# header comment\nAI_API_KEY=old\n\n# trailing note\nMESSAGE_ANALYSIS_MODE=batch\n", "utf8");
  const store = new DotenvFileStore(path);

  const updated = await store.setMany({ AI_API_KEY: "new" });

  assert.deepEqual(updated, ["AI_API_KEY"]);
  const content = await readFile(path, "utf8");
  assert.match(content, /# header comment/);
  assert.match(content, /# trailing note/);
  assert.match(content, /AI_API_KEY=new/);
  assert.doesNotMatch(content, /AI_API_KEY=old/);
  assert.match(content, /\n\n/); // blank line preserved
});

test("appends a new key when not present", async () => {
  const path = await tempEnvPath();
  await writeFile(path, "MESSAGE_ANALYSIS_MODE=batch\n", "utf8");
  const store = new DotenvFileStore(path);

  await store.setMany({ TELEGRAM_BOT_TOKEN: "123:abc" });

  const values = await store.read();
  assert.equal(values.MESSAGE_ANALYSIS_MODE, "batch");
  assert.equal(values.TELEGRAM_BOT_TOKEN, "123:abc");
});

test("creates the file when it does not exist", async () => {
  const path = await tempEnvPath();
  const store = new DotenvFileStore(path);

  await store.setMany({ AI_API_KEY: "secret" });

  assert.equal((await store.read()).AI_API_KEY, "secret");
});

test("quotes values containing spaces or special characters and round-trips them", async () => {
  const path = await tempEnvPath();
  const store = new DotenvFileStore(path);

  await store.setMany({ AI_API_KEY: "has space #hash" });

  const content = await readFile(path, "utf8");
  assert.match(content, /AI_API_KEY="has space #hash"/);
  assert.equal((await store.read()).AI_API_KEY, "has space #hash");
});

test("presence reports set and unset keys", async () => {
  const path = await tempEnvPath();
  await writeFile(path, "AI_API_KEY=secret\n", "utf8");
  const store = new DotenvFileStore(path);

  const presence = await store.presence(["AI_API_KEY", "TELEGRAM_BOT_TOKEN"]);

  assert.equal(presence.AI_API_KEY, true);
  assert.equal(presence.TELEGRAM_BOT_TOKEN, false);
});
