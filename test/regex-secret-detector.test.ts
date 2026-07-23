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

test("redacts AWS access key ids", () => {
  const detector = new RegexSecretDetector();
  const secret = "AKIAIOSFODNN7EXAMPLE";

  const result = detector.redact(`key ${secret} rotated`);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.kind, "api_key");
  assert.doesNotMatch(result.text, new RegExp(secret));
});

test("redacts GitHub personal access tokens", () => {
  const detector = new RegexSecretDetector();
  const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

  const result = detector.redact(`use ${secret} for ci`);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.kind, "access_token");
  assert.doesNotMatch(result.text, new RegExp(secret));
});

test("redacts JWTs", () => {
  const detector = new RegexSecretDetector();
  const secret =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  const result = detector.redact(`token: ${secret}`);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.kind, "access_token");
  assert.doesNotMatch(result.text, /eyJhbGciOiJIUzI1NiJ9/);
});

test("redacts Telegram bot tokens", () => {
  const detector = new RegexSecretDetector();
  const secret = "987654321:ABCDefGHIjklMNOpqrsTUVwxyz012345678";

  const result = detector.redact(`BOT_TOKEN=${secret}`);

  assert.equal(result.findings[0]?.kind, "access_token");
  assert.doesNotMatch(result.text, new RegExp(secret));
});

test("redacts bearer authorization headers", () => {
  const detector = new RegexSecretDetector();

  const result = detector.redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");

  assert.equal(result.findings[0]?.kind, "access_token");
  assert.doesNotMatch(result.text, /abcdefghijklmnopqrstuvwxyz123456/);
});

test("redacts database URIs with embedded credentials", () => {
  const detector = new RegexSecretDetector();
  const secret = "postgres://admin:s3cr3tpw@db.example.com:5432/app";

  const result = detector.redact(`DATABASE_URL=${secret}`);

  assert.equal(result.findings[0]?.kind, "connection_secret");
  assert.doesNotMatch(result.text, /s3cr3tpw/);
});

test("redacts Slack webhook urls", () => {
  const detector = new RegexSecretDetector();
  const secret = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";

  const result = detector.redact(`notify ${secret}`);

  assert.equal(result.findings[0]?.kind, "connection_secret");
  assert.doesNotMatch(result.text, /XXXXXXXXXXXXXXXXXXXXXXXX/);
});

test("does not redact ordinary prose", () => {
  const detector = new RegexSecretDetector();

  const result = detector.redact("Let's ship the release and review the bearer of good news tomorrow.");

  assert.equal(result.findings.length, 0);
});
