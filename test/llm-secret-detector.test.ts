import test from "node:test";
import assert from "node:assert/strict";
import type { LoggerPort } from "../src/application/ports/logger.js";
import type { RedactionPolicyProvider } from "../src/application/ports/redaction-policy-provider.js";
import type { SecretDetectorPort } from "../src/application/ports/secret-detector.js";
import type {
  TextCompletionInput,
  TextCompletionPort,
  TextCompletionResult,
} from "../src/application/ports/text-completion.js";
import {
  DEFAULT_REDACTION_POLICY,
  type RedactionPolicy,
} from "../src/domain/security/redaction-policy.js";
import { GuardedSecretDetector } from "../src/infrastructure/security/guarded-secret-detector.js";
import {
  LlmSecretDetector,
  SecretGuardUnavailableError,
} from "../src/infrastructure/security/llm-secret-detector.js";
import { OpenAiCompatibleTextCompletion } from "../src/infrastructure/reasoning/openai-compatible-text-completion.js";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

class SilentLogger implements LoggerPort {
  public readonly errors: string[] = [];
  public readonly warnings: string[] = [];
  public info(): void {}
  public warn(message: string): void {
    this.warnings.push(message);
  }
  public error(message: string): void {
    this.errors.push(message);
  }
}

class StubPolicyProvider implements RedactionPolicyProvider {
  public policy: RedactionPolicy = DEFAULT_REDACTION_POLICY;
  public currentRedactionPolicy(): RedactionPolicy {
    return this.policy;
  }
}

class StubCompletion implements TextCompletionPort {
  public readonly calls: TextCompletionInput[] = [];

  public constructor(private readonly reply: string | Error) {}

  public async complete(input: TextCompletionInput): Promise<TextCompletionResult> {
    this.calls.push(input);
    if (this.reply instanceof Error) {
      throw this.reply;
    }
    return { text: this.reply };
  }
}

function detector(reply: string | Error, provider = new StubPolicyProvider()): {
  readonly detector: LlmSecretDetector;
  readonly completion: StubCompletion;
  readonly provider: StubPolicyProvider;
} {
  const completion = new StubCompletion(reply);
  return {
    detector: new LlmSecretDetector(completion, provider, new SilentLogger()),
    completion,
    provider,
  };
}

test("masks a credential written as prose, which pattern rules miss", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "password", value: "bluebird77" }] }],
  }));

  const [result] = await guard.redactMany(["the wifi password is bluebird77, do not share"]);

  assert.equal(result?.text, "the wifi password is [REDACTED:password], do not share");
  assert.equal(result?.findings.length, 1);
  assert.equal(result?.findings[0]?.kind, "password");
});

test("masking is local: the model's reply never becomes the message text", async () => {
  // A model that returns rewritten prose instead of literals must not be able to
  // replace the message. Only literals present in the text are ever applied.
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "password", value: "a completely different sentence" }] }],
  }));

  const [result] = await guard.redactMany(["the wifi password is bluebird77"]);

  assert.equal(result?.text, "the wifi password is bluebird77");
  assert.equal(result?.findings.length, 0);
});

test("inspects a whole window in one call so cost is per window", async () => {
  const { detector: guard, completion } = detector(JSON.stringify({ segments: [] }));

  await guard.redactMany(["one", "two", "three", "four"]);

  assert.equal(completion.calls.length, 1);
  assert.deepEqual(JSON.parse(completion.calls[0]?.user ?? "[]"), [
    { id: 0, text: "one" },
    { id: 1, text: "two" },
    { id: 2, text: "three" },
    { id: 3, text: "four" },
  ]);
});

test("masks every occurrence of a repeated secret", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "api_key", value: "abcd1234efgh" }] }],
  }));

  const [result] = await guard.redactMany(["key abcd1234efgh and again abcd1234efgh"]);

  assert.equal(result?.text, "key [REDACTED:api_key] and again [REDACTED:api_key]");
  assert.equal(result?.findings.length, 2);
});

test("a very short literal is ignored so the message cannot be shredded", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "password", value: "a" }] }],
  }));

  const [result] = await guard.redactMany(["a plan a day keeps a manager away"]);

  assert.equal(result?.text, "a plan a day keeps a manager away");
});

test("an unknown finding kind is ignored rather than trusted", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "credit_card", value: "4111111111111111" }] }],
  }));

  const [result] = await guard.redactMany(["card 4111111111111111"]);

  // The domain vocabulary is fixed; a kind outside it has no placeholder to render.
  assert.equal(result?.text, "card 4111111111111111");
});

test("kind names are normalised to the domain vocabulary", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "API Key", value: "abcd1234efgh" }] }],
  }));

  const [result] = await guard.redactMany(["key abcd1234efgh"]);
  assert.equal(result?.text, "key [REDACTED:api_key]");
});

test("a segment id outside the input range cannot corrupt another field", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 7, findings: [{ kind: "password", value: "secret-one" }] }],
  }));

  const results = await guard.redactMany(["holds secret-one", "second"]);

  assert.equal(results[0]?.text, "holds secret-one");
  assert.equal(results[1]?.text, "second");
});

test("a transport failure raises a guard-unavailable error, never clean text", async () => {
  const { detector: guard } = detector(new Error("503 from provider"));

  await assert.rejects(guard.redactMany(["some text"]), SecretGuardUnavailableError);
});

test("unparseable output is a guard failure, not an empty result", async () => {
  const { detector: guard } = detector("I could not find any secrets, sorry!");

  // Treating garbage as "no secrets found" would turn every model hiccup into a leak.
  await assert.rejects(guard.redactMany(["password: hunter2supersecret"]), SecretGuardUnavailableError);
});

test("a response missing the segments array is a guard failure", async () => {
  const { detector: guard } = detector(JSON.stringify({ findings: [] }));
  await assert.rejects(guard.redactMany(["text"]), /missing a segments array/);
});

test("a fenced JSON reply is accepted", async () => {
  const { detector: guard } = detector('```json\n{"segments":[{"id":0,"findings":[{"kind":"password","value":"bluebird77"}]}]}\n```');

  const [result] = await guard.redactMany(["password is bluebird77"]);
  assert.equal(result?.text, "password is [REDACTED:password]");
});

test("disabling every category skips the call entirely", async () => {
  const provider = new StubPolicyProvider();
  provider.policy = {
    ...DEFAULT_REDACTION_POLICY,
    categories: {
      api_key: false,
      access_token: false,
      private_key: false,
      seed_phrase: false,
      password: false,
      connection_secret: false,
    },
  };
  const { detector: guard, completion } = detector(JSON.stringify({ segments: [] }), provider);

  const results = await guard.redactMany(["password: hunter2supersecret"]);

  assert.equal(completion.calls.length, 0);
  assert.equal(results[0]?.text, "password: hunter2supersecret");
});

test("only enabled categories are offered to the model", async () => {
  const provider = new StubPolicyProvider();
  provider.policy = {
    ...DEFAULT_REDACTION_POLICY,
    categories: { ...DEFAULT_REDACTION_POLICY.categories, password: false },
  };
  const { detector: guard, completion } = detector(JSON.stringify({ segments: [] }), provider);

  await guard.redactMany(["text"]);

  const system = completion.calls[0]?.system ?? "";
  assert.match(system, /Allowed kinds: api_key, access_token, private_key, seed_phrase, connection_secret/);
});

test("the custom placeholder template is honoured", async () => {
  const provider = new StubPolicyProvider();
  provider.policy = { ...DEFAULT_REDACTION_POLICY, placeholder: "<<{kind}>>" };
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "password", value: "bluebird77" }] }],
  }), provider);

  const [result] = await guard.redactMany(["pw bluebird77"]);
  assert.equal(result?.text, "pw <<password>>");
});

test("fail closed: a guard outage still applies pattern redaction, then refuses to proceed", async () => {
  const logger = new SilentLogger();
  const { detector: guard } = detector(new Error("provider down"));
  const composite = new GuardedSecretDetector(guard, new RegexSecretDetector(), logger);

  await assert.rejects(
    composite.redactMany(["token sk_live_abcdefghijklmnopqrstuvwxyz"]),
    SecretGuardUnavailableError,
  );
  // Patterns ran, so the operator can see what was caught before the stop.
  assert.match(logger.errors.join(" "), /refusing to analyse this window/);
});

test("degrade policy falls back to pattern rules and says so loudly", async () => {
  const logger = new SilentLogger();
  const { detector: guard } = detector(new Error("provider down"));
  const composite = new GuardedSecretDetector(guard, new RegexSecretDetector(), logger, {
    onFailure: "degrade_to_patterns",
  });

  const [result] = await composite.redactMany(["token sk_live_abcdefghijklmnopqrstuvwxyz"]);

  assert.match(result?.text ?? "", /\[REDACTED:api_key\]/);
  assert.match(logger.warnings.join(" "), /degrading to pattern rules only/);
});

test("the guard is authoritative when it succeeds; patterns are not consulted", async () => {
  const { detector: guard } = detector(JSON.stringify({
    segments: [{ id: 0, findings: [{ kind: "password", value: "bluebird77" }] }],
  }));
  const composite = new GuardedSecretDetector(guard, new RegexSecretDetector(), new SilentLogger());

  // The pattern catalog would also match sk_live..., but the guard's answer is used
  // as-is so there is exactly one source of truth per call.
  const [result] = await composite.redactMany(["password is bluebird77"]);

  assert.equal(result?.text, "password is [REDACTED:password]");
});

test("a non-guard error is not swallowed by the fallback", async () => {
  const buggy: SecretDetectorPort = {
    redact: () => ({ text: "", findings: [] }),
    redactMany: async (): Promise<never> => {
      throw new TypeError("programming error");
    },
  };
  const composite = new GuardedSecretDetector(buggy, new RegexSecretDetector(), new SilentLogger());

  // Only SecretGuardUnavailableError means "the guard is down"; a bug must surface.
  await assert.rejects(composite.redactMany(["text"]), TypeError);
});

test("a truncated guard response reports the token limit, not an empty answer", async () => {
  // Small reasoning models spend hidden tokens before emitting JSON, so hitting the
  // cap yields an empty message. The operator needs to be told which knob to turn.
  const completion = new OpenAiCompatibleTextCompletion(
    { provider: "nvidia", apiKey: "nvapi-test", model: "guard-test", maxTokens: 1024 },
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
      text: async () => "",
    })) as unknown as typeof fetch,
  );

  await assert.rejects(
    completion.complete({ system: "s", user: "u" }),
    /hit the 1024 output token limit before producing any content/,
  );
});
