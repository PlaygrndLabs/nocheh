import assert from "node:assert/strict";
import test from "node:test";
import type { SecretDetectorPort } from "../src/application/ports/secret-detector.js";
import type { RedactedContent } from "../src/domain/security/redaction.js";
import { prepareTelegramMemoryBenchmarkCorpus } from "../src/infrastructure/evaluation/telegram-memory-benchmark-preparer.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

class RecordingModelGuard implements SecretDetectorPort {
  public readonly inputs: string[] = [];
  public calls = 0;

  public async redact(text: string): Promise<RedactedContent> {
    const results = await this.redactMany([text]);
    return results[0] ?? { text, findings: [] };
  }

  public async redactMany(texts: readonly string[]): Promise<readonly RedactedContent[]> {
    this.calls += 1;
    this.inputs.push(...texts);
    return texts.map((text) => {
      const password = "bluebird77";
      const start = text.indexOf(password);
      return start < 0
        ? { text, findings: [] }
        : {
            text: text.replace(password, "[REDACTED:password]"),
            findings: [{ kind: "password", start, end: start + password.length }],
          };
    });
  }
}

test("Telegram benchmark preparation applies patterns before the model guard and preserves source ids", async () => {
  const guard = new RecordingModelGuard();
  const result = await prepareTelegramMemoryBenchmarkCorpus({
    id: 42,
    messages: [
      {
        id: 2,
        type: "message",
        date: "2026-01-02T00:00:00.000Z",
        from: "Ehsan",
        from_id: "user-2",
        text: "رمز وای‌فای bluebird77 است",
      },
      { id: 99, type: "service", date: "2026-01-01T12:00:00.000Z", text: "joined" },
      {
        id: 1,
        type: "message",
        date: "2026-01-01T00:00:00.000Z",
        from: "Mak",
        from_id: "user-1",
        text: "API sk-12345678901234567890",
      },
      { id: 3, type: "message", date: "2026-01-03T00:00:00.000Z", text: "" },
    ],
  }, new RegexSecretDetector(), guard);

  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map((message) => message.id), ["telegram:42:1", "telegram:42:2"]);
  assert.equal(result.messages[0]?.text, "API [REDACTED:api_key]");
  assert.equal(result.messages[1]?.text, "رمز وای‌فای [REDACTED:password] است");
  assert.equal(result.messages[1]?.language, "mixed");
  assert.equal(result.patternFindingCount, 1);
  assert.equal(result.guardFindingCount, 1);
  assert.equal(guard.calls, 1);
  assert.ok(guard.inputs.every((text) => !text.includes("sk-12345678901234567890")));
});

test("Telegram benchmark preparation bounds model-guard batch cardinality", async () => {
  const guard = new RecordingModelGuard();
  const messages = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    type: "message",
    date: `2026-01-0${index + 1}T00:00:00.000Z`,
    text: `message ${index + 1}`,
  }));

  const result = await prepareTelegramMemoryBenchmarkCorpus(
    { id: 42, messages },
    new RegexSecretDetector(),
    guard,
    2,
  );

  assert.equal(result.messages.length, 5);
  assert.equal(guard.calls, 3);
});

test("Telegram benchmark preparation retries only a failed guard batch", async () => {
  const successful = new RecordingModelGuard();
  let calls = 0;
  const flaky: SecretDetectorPort = {
    redact: (text) => ({ text, findings: [] }),
    redactMany: async (texts) => {
      calls += 1;
      if (calls === 2) throw new Error("transient timeout");
      return successful.redactMany(texts);
    },
  };
  const messages = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    type: "message",
    date: `2026-01-0${index + 1}T00:00:00.000Z`,
    text: `message ${index + 1}`,
  }));

  const result = await prepareTelegramMemoryBenchmarkCorpus(
    { id: 42, messages },
    new RegexSecretDetector(),
    flaky,
    2,
    2,
  );

  assert.equal(result.messages.length, 5);
  assert.equal(calls, 4);
});

test("Telegram benchmark preparation fails when a detector changes result cardinality", async () => {
  const broken: SecretDetectorPort = {
    redact: (text) => ({ text, findings: [] }),
    redactMany: async () => [],
  };

  await assert.rejects(
    prepareTelegramMemoryBenchmarkCorpus({
      id: 42,
      messages: [{ id: 1, type: "message", date: "2026-01-01T00:00:00.000Z", text: "hello" }],
    }, broken, new RecordingModelGuard()),
    /pattern detector returned 0 results for 1 messages/,
  );
});
