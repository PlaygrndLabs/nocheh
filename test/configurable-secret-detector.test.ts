import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurableSecretDetector } from "../src/infrastructure/security/configurable-secret-detector.js";
import type { RedactionPolicyProvider } from "../src/application/ports/redaction-policy-provider.js";
import {
  DEFAULT_REDACTION_POLICY,
  type CustomRedactionPattern,
  type RedactionPolicy,
} from "../src/domain/security/redaction-policy.js";

class StubPolicyProvider implements RedactionPolicyProvider {
  public policy: RedactionPolicy = DEFAULT_REDACTION_POLICY;
  public currentRedactionPolicy(): RedactionPolicy {
    return this.policy;
  }
}

function policy(overrides: Partial<RedactionPolicy>): RedactionPolicy {
  return { ...DEFAULT_REDACTION_POLICY, ...overrides };
}

test("redacts with all built-in categories enabled by default", () => {
  const provider = new StubPolicyProvider();
  const detector = new ConfigurableSecretDetector(provider);

  const result = detector.redact("password=supersecret and sk_live_abcdefghijklmnopqrstuvwxyz");

  assert.equal(result.findings.length, 2);
  assert.match(result.text, /\[REDACTED:password\]/);
  assert.match(result.text, /\[REDACTED:api_key\]/);
});

test("disabling a category stops that redaction (live, no restart)", () => {
  const provider = new StubPolicyProvider();
  const detector = new ConfigurableSecretDetector(provider);

  provider.policy = policy({
    categories: { ...DEFAULT_REDACTION_POLICY.categories, password: false },
  });

  const result = detector.redact("password=supersecret and sk_live_abcdefghijklmnopqrstuvwxyz");

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.kind, "api_key");
  assert.match(result.text, /password=supersecret/);
});

test("applies enabled custom patterns", () => {
  const provider = new StubPolicyProvider();
  const detector = new ConfigurableSecretDetector(provider);
  const custom: CustomRedactionPattern = {
    id: "c1",
    kind: "api_key",
    label: "Internal key",
    regex: "INTERNAL-[0-9]{6}",
    enabled: true,
  };
  provider.policy = policy({ customPatterns: [custom] });

  const result = detector.redact("token INTERNAL-123456 here");

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.kind, "api_key");
  assert.doesNotMatch(result.text, /INTERNAL-123456/);
});

test("skips disabled custom patterns", () => {
  const provider = new StubPolicyProvider();
  const detector = new ConfigurableSecretDetector(provider);
  provider.policy = policy({
    customPatterns: [{ id: "c1", kind: "api_key", label: "x", regex: "INTERNAL-[0-9]{6}", enabled: false }],
  });

  const result = detector.redact("token INTERNAL-123456 here");

  assert.equal(result.findings.length, 0);
});

test("honours a custom placeholder template", () => {
  const provider = new StubPolicyProvider();
  const detector = new ConfigurableSecretDetector(provider);
  provider.policy = policy({ placeholder: "<<{kind}>>" });

  const result = detector.redact("password=supersecret");

  assert.match(result.text, /<<password>>/);
});
