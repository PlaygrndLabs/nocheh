import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AesGcmEncryption } from "../src/infrastructure/security/aes-gcm-encryption.js";
import { openSqliteDatabase, type SqliteDatabase } from "../src/infrastructure/sqlite/sqlite-database.js";
import { SqliteAppConfigRepository } from "../src/infrastructure/sqlite/sqlite-app-config-repository.js";
import { SettingsService } from "../src/application/services/settings-service.js";

const encryption = new AesGcmEncryption("settings-service-test-secret");

async function testDatabase(): Promise<SqliteDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "nocheh-settings-"));
  return openSqliteDatabase(join(dir, "config.sqlite"));
}

test("returns default redaction policy when nothing is stored", async () => {
  const database = await testDatabase();
  try {
    const service = new SettingsService(new SqliteAppConfigRepository(database, encryption));
    await service.init();

    const policy = service.currentRedactionPolicy();
    assert.equal(policy.categories.password, true);
    assert.equal(policy.categories.api_key, true);
    assert.equal(policy.customPatterns.length, 0);
    assert.equal(policy.placeholder, "[REDACTED:{kind}]");
  } finally {
    database.close();
  }
});

test("persists a redaction policy update and reloads it", async () => {
  const database = await testDatabase();
  try {
    const service = new SettingsService(new SqliteAppConfigRepository(database, encryption));
    await service.init();

    await service.updateRedactionPolicy({
      categories: { password: false },
      customPatterns: [{ id: "c1", kind: "api_key", label: "Internal", regex: "INTERNAL-[0-9]{6}", enabled: true }],
      placeholder: "<<{kind}>>",
    });

    // Cache reflects the change immediately.
    assert.equal(service.currentRedactionPolicy().categories.password, false);

    // A fresh service hydrating from the same DB sees the persisted policy.
    const reloaded = new SettingsService(new SqliteAppConfigRepository(database, encryption));
    await reloaded.init();
    const policy = reloaded.currentRedactionPolicy();
    assert.equal(policy.categories.password, false);
    assert.equal(policy.categories.api_key, true);
    assert.equal(policy.customPatterns.length, 1);
    assert.equal(policy.customPatterns[0]?.regex, "INTERNAL-[0-9]{6}");
    assert.equal(policy.placeholder, "<<{kind}>>");
  } finally {
    database.close();
  }
});

test("rejects an invalid custom pattern regex", async () => {
  const database = await testDatabase();
  try {
    const service = new SettingsService(new SqliteAppConfigRepository(database, encryption));
    await service.init();

    await assert.rejects(
      service.updateRedactionPolicy({
        customPatterns: [{ id: "bad", kind: "api_key", label: "bad", regex: "([", enabled: true }],
      }),
    );
  } finally {
    database.close();
  }
});

test("app config repository round-trips encrypted values", async () => {
  const database = await testDatabase();
  try {
    const repository = new SqliteAppConfigRepository(database, encryption);
    await repository.set("plain", JSON.stringify({ a: 1 }), false);
    await repository.set("secret", JSON.stringify({ token: "value" }), true);

    const all = await repository.getAll();
    assert.equal(all.plain, JSON.stringify({ a: 1 }));
    assert.equal(all.secret, JSON.stringify({ token: "value" }));
  } finally {
    database.close();
  }
});
