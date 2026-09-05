import test from "node:test";
import assert from "node:assert/strict";
import type { EnvStorePort } from "../src/application/ports/env-store.js";
import { createSetupRoutes, WRITABLE_ENV_KEYS } from "../src/interfaces/http/api/create-setup-routes.js";
import {
  AI_MODEL_ROLES,
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER_ID,
  requiredAiProviderEnvKeys,
} from "../src/application/config/ai-provider-catalog.js";
import type { RequestContext } from "../src/interfaces/http/router.js";

class InMemoryEnvStore implements EnvStorePort {
  public constructor(private values: Record<string, string> = {}) {}

  public async read(): Promise<Record<string, string>> {
    return { ...this.values };
  }

  public async setMany(values: Record<string, string>): Promise<readonly string[]> {
    this.values = { ...this.values, ...values };
    return Object.keys(values);
  }

  public async presence(keys: readonly string[]): Promise<Record<string, boolean>> {
    const presence: Record<string, boolean> = {};
    for (const key of keys) {
      presence[key] = (this.values[key] ?? "").trim().length > 0;
    }
    return presence;
  }
}

const context = { body: undefined } as unknown as RequestContext;

interface StatusRole {
  readonly id: string;
  readonly provider: string;
  readonly model?: string;
  readonly supported: boolean;
  readonly ready: boolean;
  readonly providers: readonly { readonly id: string; readonly defaultModel?: string; readonly modelRequired: boolean }[];
}

interface StatusBody {
  readonly hasAiKey: boolean;
  readonly aiProvider: string;
  readonly aiModel?: string;
  readonly roles: readonly StatusRole[];
  readonly providers: readonly { readonly id: string; readonly roles: readonly string[] }[];
}

async function status(values: Record<string, string>): Promise<StatusBody> {
  const routes = createSetupRoutes(new InMemoryEnvStore(values));
  const result = await routes.getStatus(context);
  return result.body as StatusBody;
}

function role(body: StatusBody, id: string): StatusRole {
  const found = body.roles.find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `role ${id} must be reported`);
  return found;
}

test("setup status reports the NVIDIA provider ready from an api key alone", async () => {
  const body = await status({ AI_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-test" });
  assert.equal(body.aiProvider, "nvidia");
  assert.equal(body.hasAiKey, true);
  // Model is optional for NVIDIA, so the catalog default is what actually runs.
  assert.equal(body.aiModel, "z-ai/glm-5.2");
});

test("setup status echoes an explicitly configured NVIDIA model", async () => {
  const body = await status({ AI_PROVIDER: "NVIDIA ", NVIDIA_API_KEY: "nvapi-test", NVIDIA_MODEL: "z-ai/glm-5.1" });
  assert.equal(body.aiProvider, "nvidia");
  assert.equal(body.aiModel, "z-ai/glm-5.1");
});

test("setup status keeps Anthropic in dry-run until both key and model are set", async () => {
  const keyOnly = await status({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.equal(keyOnly.hasAiKey, false);

  const complete = await status({
    AI_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MODEL: "claude-sonnet-test",
  });
  assert.equal(complete.hasAiKey, true);
  assert.equal(complete.aiModel, "claude-sonnet-test");
});

test("setup status reports dry-run for missing and unknown providers", async () => {
  const unset = await status({});
  assert.equal(unset.aiProvider, "none");
  assert.equal(unset.hasAiKey, false);
  assert.equal(unset.aiModel, undefined);

  const unknown = await status({ AI_PROVIDER: "openai", NVIDIA_API_KEY: "nvapi-test" });
  assert.equal(unknown.aiProvider, "openai");
  assert.equal(unknown.hasAiKey, false);
});

test("setup status advertises the provider catalog so the dashboard hardcodes nothing", async () => {
  const body = await status({});
  assert.deepEqual(body.providers.map((provider) => provider.id), AI_PROVIDERS.map((provider) => provider.id));
  assert.equal(body.providers.some((provider) => provider.id === DEFAULT_AI_PROVIDER_ID), true);
  const textRole = role(body, "text_analysis");
  const nvidia = textRole.providers.find((provider) => provider.id === "nvidia");
  assert.equal(nvidia?.modelRequired, false);
  assert.equal(textRole.providers.find((provider) => provider.id === "anthropic")?.modelRequired, true);
});

test("setup status reports every model role independently", async () => {
  const body = await status({});
  assert.deepEqual(
    body.roles.map((candidate) => candidate.id),
    AI_MODEL_ROLES.map((candidate) => candidate.id),
  );
  for (const candidate of body.roles) {
    assert.equal(candidate.ready, false);
    assert.equal(candidate.provider, "none");
  }
});

test("image and voice roles are ready on their own without the text role", async () => {
  const body = await status({
    AI_IMAGE_PROVIDER: "nvidia",
    AI_AUDIO_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "nvapi-test",
  });

  const image = role(body, "image_understanding");
  assert.equal(image.ready, true);
  assert.equal(image.model, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
  // The same omni model serves audio by default, but the roles stay separately switchable.
  assert.equal(role(body, "audio_understanding").model, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
  // Roles degrade independently: text analysis is still dry-run.
  assert.equal(role(body, "text_analysis").ready, false);
});

test("each content type can point at a different provider", async () => {
  const body = await status({
    AI_IMAGE_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "nvapi-test",
    AI_AUDIO_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-test",
    GEMINI_AUDIO_MODEL: "gemini-audio-test",
  });

  assert.equal(role(body, "image_understanding").provider, "nvidia");
  assert.equal(role(body, "audio_understanding").provider, "gemini");
  assert.equal(role(body, "audio_understanding").model, "gemini-audio-test");
  assert.equal(role(body, "audio_understanding").ready, true);
});

test("OpenAI embedding role uses its low-cost default model", async () => {
  const body = await status({
    AI_EMBEDDING_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
  });

  const embedding = role(body, "embedding");
  assert.equal(embedding.ready, true);
  assert.equal(embedding.provider, "openai");
  assert.equal(embedding.model, "text-embedding-3-small");
});

test("a role reports unsupported when the chosen provider cannot fill it", async () => {
  // Anthropic has no media adapter, so selecting it for images is a misconfiguration.
  const body = await status({ AI_IMAGE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" });

  const image = role(body, "image_understanding");
  assert.equal(image.supported, false);
  assert.equal(image.ready, false);
});

test("the secret guard role requires an explicit model id", async () => {
  const keyOnly = await status({ AI_GUARD_PROVIDER: "gemini", GEMINI_API_KEY: "test-key" });
  assert.equal(role(keyOnly, "secret_guard").ready, false);

  const complete = await status({
    AI_GUARD_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-key",
    GEMINI_GUARD_MODEL: "gemini-guard-test",
  });
  const guard = role(complete, "secret_guard");
  assert.equal(guard.ready, true);
  assert.equal(guard.model, "gemini-guard-test");
});

test("every catalog provider env key is writable and its api key stays write-only", async () => {
  const routes = createSetupRoutes(new InMemoryEnvStore({}));
  for (const provider of AI_PROVIDERS) {
    const modelEnvKeys = Object.values(provider.roles).map((support) => support.modelEnvKey);
    for (const key of [provider.apiKeyEnvKey, ...modelEnvKeys, ...provider.optionalEnvKeys]) {
      assert.equal(
        (WRITABLE_ENV_KEYS as readonly string[]).includes(key),
        true,
        `${key} must be writable from the dashboard`,
      );
    }
    // The api key is always required; the model only when the role has no default.
    for (const roleDescriptor of AI_MODEL_ROLES) {
      const support = provider.roles[roleDescriptor.id];
      if (support === undefined) {
        continue;
      }
      const required = requiredAiProviderEnvKeys(provider, roleDescriptor.id);
      assert.equal(required.includes(provider.apiKeyEnvKey), true);
      assert.equal(required.includes(support.modelEnvKey), support.defaultModel === undefined);
    }
  }

  for (const roleDescriptor of AI_MODEL_ROLES) {
    assert.equal(
      (WRITABLE_ENV_KEYS as readonly string[]).includes(roleDescriptor.providerEnvKey),
      true,
      `${roleDescriptor.providerEnvKey} must be writable from the dashboard`,
    );
  }

  const envResult = await routes.getEnv(context);
  const keys = (envResult.body as { keys: Record<string, string> }).keys;
  for (const provider of AI_PROVIDERS) {
    // Presence only: the dashboard must never receive a credential value.
    assert.equal(keys[provider.apiKeyEnvKey], "unset");
  }
});

test("setup putEnv rejects keys outside the allow-list", async () => {
  const store = new InMemoryEnvStore({});
  const routes = createSetupRoutes(store);
  const result = await routes.putEnv({
    body: { values: { AI_PROVIDER: "nvidia", NVIDIA_API_KEY: "nvapi-test", HOME: "/tmp" } },
  } as unknown as RequestContext);

  const body = result.body as { updated: readonly string[]; rejected: readonly string[]; restartRequired: boolean };
  assert.deepEqual([...body.updated].sort(), ["AI_PROVIDER", "NVIDIA_API_KEY"]);
  assert.deepEqual(body.rejected, ["HOME"]);
  assert.equal(body.restartRequired, true);
  assert.equal((await store.read()).HOME, undefined);
});
