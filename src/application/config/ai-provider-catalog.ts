/**
 * Catalog of selectable AI providers.
 *
 * Pure configuration metadata: which env keys a provider needs, which of them are
 * secrets, and its default model. Adapter construction stays in the composition
 * root, but every layer (composition root, setup API, dashboard) reads provider
 * requirements from here so the list never drifts.
 */

export interface AiProviderDescriptor {
  /** Value stored in AI_PROVIDER. */
  readonly id: string;
  readonly label: string;
  /** Env key holding the credential. Always treated as a secret. */
  readonly apiKeyEnvKey: string;
  /** Env key holding the model id. */
  readonly modelEnvKey: string;
  /** Model used when modelEnvKey is unset. Undefined means the model is required. */
  readonly defaultModel?: string;
  /** Additional non-secret env keys the dashboard may write. */
  readonly optionalEnvKeys: readonly string[];
  readonly notes: string;
}

/** Selected by default for new setups. */
export const DEFAULT_AI_PROVIDER_ID = "nvidia";

export const AI_PROVIDERS: readonly AiProviderDescriptor[] = [
  {
    id: "nvidia",
    label: "NVIDIA API Catalog (GLM-5.2)",
    apiKeyEnvKey: "NVIDIA_API_KEY",
    modelEnvKey: "NVIDIA_MODEL",
    defaultModel: "z-ai/glm-5.2",
    optionalEnvKeys: ["NVIDIA_BASE_URL", "NVIDIA_JSON_RESPONSE_FORMAT"],
    notes: "OpenAI-compatible endpoint at integrate.api.nvidia.com. Key format nvapi-...",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiKeyEnvKey: "ANTHROPIC_API_KEY",
    modelEnvKey: "ANTHROPIC_MODEL",
    optionalEnvKeys: [],
    notes: "Anthropic Messages API. Model id is required. Key format sk-ant-...",
  },
];

export function findAiProvider(id: string | undefined): AiProviderDescriptor | undefined {
  const normalized = normalizeAiProviderId(id);
  return normalized === undefined ? undefined : AI_PROVIDERS.find((provider) => provider.id === normalized);
}

export function normalizeAiProviderId(id: string | undefined): string | undefined {
  const normalized = id?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

/** Env keys a provider must have set before it can leave dry-run mode. */
export function requiredAiProviderEnvKeys(provider: AiProviderDescriptor): readonly string[] {
  return provider.defaultModel === undefined
    ? [provider.apiKeyEnvKey, provider.modelEnvKey]
    : [provider.apiKeyEnvKey];
}

/** Every provider env key the dashboard is allowed to write. */
export function aiProviderEnvKeys(): readonly string[] {
  return AI_PROVIDERS.flatMap((provider) => [
    provider.apiKeyEnvKey,
    provider.modelEnvKey,
    ...provider.optionalEnvKeys,
  ]);
}

/** Provider env keys whose values must never be read back. */
export function aiProviderSecretEnvKeys(): readonly string[] {
  return AI_PROVIDERS.map((provider) => provider.apiKeyEnvKey);
}

export function aiProviderIds(): readonly string[] {
  return AI_PROVIDERS.map((provider) => provider.id);
}
