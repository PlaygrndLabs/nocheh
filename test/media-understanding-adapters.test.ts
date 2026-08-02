import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  MediaNotPerceivedError,
  NvidiaOmniMediaUnderstanding,
} from "../src/infrastructure/reasoning/nvidia-omni-media-understanding.js";
import { GeminiMediaUnderstanding } from "../src/infrastructure/reasoning/gemini-media-understanding.js";
import type { FetchedAttachment } from "../src/application/ports/media-understanding.js";

const IMAGE: FetchedAttachment = {
  kind: "image",
  mimeType: "image/jpeg",
  bytes: new Uint8Array([1, 2, 3]),
  fileId: "file-1",
};

const VOICE: FetchedAttachment = {
  kind: "audio",
  mimeType: "audio/ogg",
  bytes: new Uint8Array([4, 5, 6]),
  fileId: "voice-1",
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(payload: unknown, captured: Captured[], status = 200): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
}

function nvidiaPayload(content: string): unknown {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 12 },
  };
}

test("NVIDIA omni sends an image as an inline base64 data url", async () => {
  const captured: Captured[] = [];
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('{"description":"a whiteboard","transcript":null,"confidence":0.8}'), captured),
  );

  const result = await adapter.understand({ attachment: IMAGE, hint: "notes from the call" });

  const content = (captured[0]?.body.messages as { role: string; content: unknown }[])[1]?.content as Record<string, unknown>[];
  assert.equal(content[0]?.type, "text");
  assert.match(String(content[0]?.text), /notes from the call/);
  assert.equal(content[1]?.type, "image_url");
  assert.equal(
    (content[1]?.image_url as { url: string }).url,
    `data:image/jpeg;base64,${Buffer.from(IMAGE.bytes).toString("base64")}`,
  );
  assert.equal(result.understanding.description, "a whiteboard");
  assert.equal(result.understanding.transcript, undefined);
  assert.equal(result.understanding.confidence, 0.8);
  assert.equal(result.tokenUsage?.totalTokens, 52);
});

test("NVIDIA omni sends audio as an audio_url data url, not an input_audio block", async () => {
  const captured: Captured[] = [];
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('{"description":"a voice note","transcript":"move it to Thursday","confidence":0.9}'), captured),
  );

  const result = await adapter.understand({ attachment: VOICE });

  const content = (captured[0]?.body.messages as { role: string; content: unknown }[])[1]?.content as Record<string, unknown>[];
  // Verified against the live endpoint: an `input_audio` block is rejected with 400
  // "data did not match any variant of untagged enum
  // ChatCompletionRequestUserMessageContent". Audio mirrors image_url instead.
  assert.equal(content[1]?.type, "audio_url");
  assert.equal(content.some((block) => block.type === "input_audio"), false);
  assert.equal(
    (content[1]?.audio_url as { url: string }).url,
    `data:audio/ogg;base64,${Buffer.from(VOICE.bytes).toString("base64")}`,
  );
  assert.equal(result.understanding.transcript, "move it to Thursday");
});

test("the perception prompt tells the model to omit credentials rather than reproduce them", async () => {
  const captured: Captured[] = [];
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('{"description":"ok","confidence":1}'), captured),
  );

  await adapter.understand({ attachment: IMAGE });

  const system = (captured[0]?.body.messages as { role: string; content: string }[])[0]?.content ?? "";
  assert.match(system, /\[credential omitted\]/);
  assert.match(system, /do NOT reproduce it/);
});

test("a fenced JSON response is still parsed", async () => {
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('```json\n{"description":"fenced","confidence":0.7}\n```'), []),
  );

  const result = await adapter.understand({ attachment: IMAGE });
  assert.equal(result.understanding.description, "fenced");
});

test("a non-JSON response degrades to a plain description at lower confidence", async () => {
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload("Just a photo of a laptop."), []),
  );

  const result = await adapter.understand({ attachment: IMAGE });
  assert.equal(result.understanding.description, "Just a photo of a laptop.");
  assert.equal(result.understanding.confidence, 0.5);
});

test("an empty response is an error, not an empty description", async () => {
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch({ choices: [{ message: { content: "" }, finish_reason: "length" }] }, []),
  );

  await assert.rejects(adapter.understand({ attachment: IMAGE }), /returned no content \(finish_reason: length\)/);
});

test("an HTTP failure surfaces the provider status and body", async () => {
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch({ error: "model not found" }, [], 404),
  );

  await assert.rejects(adapter.understand({ attachment: IMAGE }), /failed with status 404/);
});

test("supported kinds are configurable so one model can be limited to one content type", () => {
  const imageOnly = new NvidiaOmniMediaUnderstanding({
    apiKey: "nvapi-test",
    model: "nvidia/omni-test",
    supportedKinds: ["image"],
  });

  assert.equal(imageOnly.supports("image"), true);
  assert.equal(imageOnly.supports("audio"), false);
});

test("Gemini sends inline data and keeps the key in a header, not the url", async () => {
  const captured: Captured[] = [];
  const adapter = new GeminiMediaUnderstanding(
    { apiKey: "gemini-test", model: "gemini-test-model" },
    fakeFetch({
      candidates: [{ content: { parts: [{ text: '{"description":"a voice note","transcript":"hello","confidence":0.9}' }] } }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
    }, captured),
  );

  const result = await adapter.understand({ attachment: VOICE });

  assert.match(captured[0]?.url ?? "", /models\/gemini-test-model:generateContent$/);
  assert.doesNotMatch(captured[0]?.url ?? "", /gemini-test\b(?!-model)/);
  assert.equal(captured[0]?.headers["x-goog-api-key"], "gemini-test");
  const parts = (captured[0]?.body.contents as { parts: Record<string, unknown>[] }[])[0]?.parts ?? [];
  // Opus goes inline unchanged, which is why Gemini is the no-ffmpeg audio option.
  assert.equal((parts[1]?.inlineData as { mimeType: string }).mimeType, "audio/ogg");
  assert.equal(result.understanding.transcript, "hello");
  assert.equal(result.understanding.provider, "gemini");
  assert.equal(result.tokenUsage?.totalTokens, 25);
});

test("an attachment the model says it could not access is an error, not a description", async () => {
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('{"perceived":false,"description":"No attachment provided.","confidence":1}'), []),
  );

  // Observed intermittently against the live endpoint. If this were returned as a
  // successful description it would be cached forever as "no attachment provided".
  await assert.rejects(adapter.understand({ attachment: VOICE }), MediaNotPerceivedError);
});

test("an omitted perceived field still counts as perceived", async () => {
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('{"description":"a photo of a laptop","confidence":0.8}'), []),
  );

  const result = await adapter.understand({ attachment: IMAGE });
  assert.equal(result.understanding.description, "a photo of a laptop");
});

test("the perception prompt names only the kind actually sent", async () => {
  const captured: Captured[] = [];
  const adapter = new NvidiaOmniMediaUnderstanding(
    { apiKey: "nvapi-test", model: "nvidia/omni-test" },
    fakeFetch(nvidiaPayload('{"perceived":true,"description":"ok","confidence":1}'), captured),
  );

  await adapter.understand({ attachment: VOICE });
  await adapter.understand({ attachment: IMAGE });

  const audioSystem = (captured[0]?.body.messages as { content: string }[])[0]?.content ?? "";
  const imageSystem = (captured[1]?.body.messages as { content: string }[])[0]?.content ?? "";
  // A prompt mentioning both kinds made the omni model claim it received nothing,
  // or call an audio clip "the image", roughly a quarter of the time.
  assert.match(audioSystem, /ONE audio clip\. It is audio, never an image/);
  assert.match(imageSystem, /ONE image\. It is an image, never audio/);
});
