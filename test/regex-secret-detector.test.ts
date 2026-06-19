import test from "node:test";
import assert from "node:assert/strict";
import { RegexSecretDetector } from "../src/infrastructure/security/regex-secret-detector.js";

test("redacts secrets before downstream processing", () => {
  const detector = new RegexSecretDetector();

  const result = detector.redact("TODO: rotate password=supersecret and sk_live_abcdefghijklmnopqrstuvwxyz");

  assert.equal(result.findings.length, 2);
  assert.match(result.text, /\[REDACTED:password\]/);
  assert.match(result.text, /\[REDACTED:api_key\]/);
  assert.doesNotMatch(result.text, /supersecret/);
  assert.doesNotMatch(result.text, /sk_live_abcdefghijklmnopqrstuvwxyz/);
});
