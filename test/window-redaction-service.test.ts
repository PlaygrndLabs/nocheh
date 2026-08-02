import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationWindow } from "../src/application/dto/conversation-window.js";
import type { SecretDetectorPort } from "../src/application/ports/secret-detector.js";
import { WindowRedactionService } from "../src/application/services/window-redaction-service.js";
import type { RedactedContent } from "../src/domain/security/redaction.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

class RecordingDetector implements SecretDetectorPort {
  public readonly batches: readonly string[][] = [];
  private readonly inner = new RegexSecretDetector();

  public redact(text: string): RedactedContent {
    return this.inner.redact(text);
  }

  public async redactMany(texts: readonly string[]): Promise<readonly RedactedContent[]> {
    (this.batches as string[][]).push([...texts]);
    return texts.map((text) => this.inner.redact(text));
  }
}

function windowWith(
  text: string,
  understanding?: { readonly description: string; readonly transcript?: string },
): ConversationWindow {
  return {
    platform: "telegram",
    conversationId: "chat-1",
    messages: [{
      platform: "telegram",
      conversationId: "chat-1",
      messageId: "1",
      senderId: "7",
      text,
      occurredAt: new Date("2026-06-19T12:00:00.000Z"),
      ...(understanding === undefined ? {} : {
        attachments: [{
          kind: "image" as const,
          fileUniqueId: "u-1",
          fileId: "file-1",
          understanding: {
            description: understanding.description,
            ...(understanding.transcript === undefined ? {} : { transcript: understanding.transcript }),
            confidence: 0.9,
            provider: "stub",
            model: "stub",
          },
        }],
      }),
    }],
  };
}

test("redacts a secret in an attachment description", async () => {
  const service = new WindowRedactionService(new RegexSecretDetector());

  const result = await service.execute(windowWith("", {
    description: "A screenshot showing sk_live_abcdefghijklmnopqrstuvwxyz in a terminal.",
  }));

  const described = result.window.messages[0]?.attachments?.[0]?.understanding;
  assert.equal(result.findingCount, 1);
  assert.match(described?.description ?? "", /\[REDACTED:api_key\]/);
  assert.doesNotMatch(described?.description ?? "", /sk_live/);
});

test("redacts a secret spoken in a voice note transcript", async () => {
  const service = new WindowRedactionService(new RegexSecretDetector());

  const result = await service.execute(windowWith("", {
    description: "A voice note reading out a credential.",
    transcript: "password: hunter2supersecret",
  }));

  const described = result.window.messages[0]?.attachments?.[0]?.understanding;
  assert.equal(result.findingCount, 1);
  assert.match(described?.transcript ?? "", /\[REDACTED:password\]/);
  assert.doesNotMatch(described?.transcript ?? "", /hunter2supersecret/);
});

test("pattern rules miss a credential phrased as prose, which is why the guard model exists", async () => {
  const service = new WindowRedactionService(new RegexSecretDetector());

  // Realistic speech: the built-in pattern needs "password:" immediately, so
  // "password is:" slips through. Documented so the gap is not mistaken for safety.
  const result = await service.execute(windowWith("", {
    description: "A voice note reading out a credential.",
    transcript: "the password is hunter2supersecret, do not share it",
  }));

  assert.equal(result.findingCount, 0);
  assert.match(
    result.window.messages[0]?.attachments?.[0]?.understanding?.transcript ?? "",
    /hunter2supersecret/,
  );
});

test("sends every text-bearing field in one batch so a model detector costs one call", async () => {
  const detector = new RecordingDetector();
  const service = new WindowRedactionService(detector);

  await service.execute(windowWith("check this", {
    description: "A whiteboard photo.",
    transcript: "spoken words",
  }));

  assert.equal(detector.batches.length, 1);
  assert.deepEqual(detector.batches[0], ["check this", "A whiteboard photo.", "spoken words"]);
});

test("reports finding counts per kind for auditing without storing values", async () => {
  const service = new WindowRedactionService(new RegexSecretDetector());

  const result = await service.execute(windowWith("key sk_live_abcdefghijklmnopqrstuvwxyz", {
    description: "password: anotherlongsecret",
  }));

  assert.equal(result.findingKinds.api_key, 1);
  assert.equal(result.findingKinds.password, 1);
  assert.equal(result.segmentCount, 2);
});

test("an empty window needs no detector call", async () => {
  const detector = new RecordingDetector();
  const service = new WindowRedactionService(detector);

  const result = await service.execute(windowWith(""));

  assert.equal(detector.batches.length, 0);
  assert.equal(result.findingCount, 0);
});

test("refuses to guess the mapping when a detector returns the wrong result count", async () => {
  const broken: SecretDetectorPort = {
    redact: (text) => ({ text, findings: [] }),
    // A model-backed detector that drops or merges entries must not be trusted to
    // line up with the input, or redacted text could land on the wrong field.
    redactMany: async () => [{ text: "only one", findings: [] }],
  };
  const service = new WindowRedactionService(broken);

  await assert.rejects(
    service.execute(windowWith("first", { description: "second" })),
    /refusing to guess the mapping/,
  );
});
