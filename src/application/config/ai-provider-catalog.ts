/**
 * Catalog of selectable AI providers and the model roles they can fill.
 *
 * Pure configuration metadata: which env keys a provider needs, which of them are
 * secrets, and its default model per role. Adapter construction stays in the
 * composition root, but every layer (composition root, setup API, dashboard) reads
 * provider requirements from here so the list never drifts.
 *
 * Roles exist because one model cannot do every job well. Credentials are shared
 * per provider; only the model id varies per role.
 */

/** A distinct job a model is selected for. */
export type AiModelRole = "text_analysis" | "image_understanding" | "audio_understanding" | "secret_guard";

export interface AiModelRoleDescriptor {
  readonly id: AiModelRole;
  readonly label: string;
  /** Env key holding the provider id for this role. */
  readonly providerEnvKey: string;
  readonly purpose: string;
  /**
   * What happens when the role is unconfigured. Roles degrade independently so a
   * missing media model never blocks text analysis.
   */
  readonly whenUnset: string;
}

export const AI_MODEL_ROLES: readonly AiModelRoleDescriptor[] = [
  {
    id: "text_analysis",
    label: "Text analysis",
    // Kept as AI_PROVIDER so existing setups keep working unchanged.
    providerEnvKey: "AI_PROVIDER",
    purpose: "Builds memory records, graph nodes and edges, tasks, and suggestions from redacted text.",
    whenUnset: "The pipeline runs in dry-run mode and produces no knowledge.",
  },
  {
    id: "image_understanding",
    label: "Image understanding",
    providerEnvKey: "AI_IMAGE_PROVIDER",
    purpose: "Describes photos, screenshots, and diagrams so the text model can reason about them.",
    whenUnset: "Images are recorded but not described; the text model only learns that an image was sent.",
  },
  {
    id: "audio_understanding",
    label: "Voice and audio understanding",
    providerEnvKey: "AI_AUDIO_PROVIDER",
    purpose: "Transcribes and summarises voice notes and audio files.",
    whenUnset: "Voice notes are recorded but not transcribed.",
  },
  {
    id: "secret_guard",
    label: "Secret guard",
    providerEnvKey: "AI_GUARD_PROVIDER",
    purpose: "Finds secrets that pattern rules miss, such as a password written in prose or spoken aloud.",
    whenUnset: "Redaction falls back to built-in pattern rules only.",
  },
];

export interface AiProviderRoleSupport {
  /** Env key holding the model id for this provider in this role. */
  readonly modelEnvKey: string;
  /** Model used when modelEnvKey is unset. Undefined means the model is required. */
  readonly defaultModel?: string;
  readonly notes?: string;
}

export interface AiProviderDescriptor {
  /** Value stored in a role's provider env key. */
  readonly id: string;
  readonly label: string;
  /** Env key holding the credential. Always treated as a secret, shared across roles. */
  readonly apiKeyEnvKey: string;
  /** Additional non-secret env keys the dashboard may write. */
  readonly optionalEnvKeys: readonly string[];
  readonly notes: string;
  /** Roles this provider can fill. A provider absent from a role cannot be selected for it. */
  readonly roles: Readonly<Partial<Record<AiModelRole, AiProviderRoleSupport>>>;
}

/** Selected by default for new setups. */
export const DEFAULT_AI_PROVIDER_ID = "nvidia";

export const AI_PROVIDERS: readonly AiProviderDescriptor[] = [
  {
    id: "nvidia",
    label: "NVIDIA API Catalog",
    apiKeyEnvKey: "NVIDIA_API_KEY",
    optionalEnvKeys: ["NVIDIA_BASE_URL", "NVIDIA_JSON_RESPONSE_FORMAT"],
    notes: "OpenAI-compatible endpoint at integrate.api.nvidia.com. Key format nvapi-...",
    roles: {
      text_analysis: {
        modelEnvKey: "NVIDIA_MODEL",
        defaultModel: "z-ai/glm-5.2",
        notes: "GLM-5.2. Text only; it cannot read images or audio.",
      },
      image_understanding: {
        modelEnvKey: "NVIDIA_IMAGE_MODEL",
        defaultModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        notes: "Omni model: reads images and audio. Verified against the live catalog.",
      },
      audio_understanding: {
        modelEnvKey: "NVIDIA_AUDIO_MODEL",
        defaultModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        notes: "Same omni model by default. Verified to transcribe Telegram's OGG/Opus directly.",
      },
      secret_guard: {
        modelEnvKey: "NVIDIA_GUARD_MODEL",
        notes: "Model id is required. Prefer a small, fast model: the guard runs once per window.",
      },
    },
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiKeyEnvKey: "ANTHROPIC_API_KEY",
    optionalEnvKeys: [],
    notes: "Anthropic Messages API. Model id is required. Key format sk-ant-...",
    roles: {
      text_analysis: { modelEnvKey: "ANTHROPIC_MODEL" },
      secret_guard: { modelEnvKey: "ANTHROPIC_GUARD_MODEL" },
    },
  },
  {
    id: "gemini",
    label: "Google Gemini",
    apiKeyEnvKey: "GEMINI_API_KEY",
    optionalEnvKeys: ["GEMINI_BASE_URL"],
    notes: "Gemini generateContent API. Model ids are required; set the one you have access to.",
    roles: {
      text_analysis: { modelEnvKey: "GEMINI_MODEL" },
      image_understanding: { modelEnvKey: "GEMINI_IMAGE_MODEL" },
      audio_understanding: {
        modelEnvKey: "GEMINI_AUDIO_MODEL",
        notes: "Alternative to the NVIDIA omni model. Also accepts OGG/Opus inline.",
      },
      secret_guard: {
        modelEnvKey: "GEMINI_GUARD_MODEL",
        notes: "Prefer a small, fast model: the guard runs once per window.",
      },
    },
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

export function findAiModelRole(id: string | undefined): AiModelRoleDescriptor | undefined {
  return AI_MODEL_ROLES.find((role) => role.id === id);
}

export function aiModelRoleIds(): readonly AiModelRole[] {
  return AI_MODEL_ROLES.map((role) => role.id);
}

/** Support metadata for a provider in a role, or undefined when it cannot fill the role. */
export function aiProviderRoleSupport(
  provider: AiProviderDescriptor,
  role: AiModelRole,
): AiProviderRoleSupport | undefined {
  return provider.roles[role];
}

/** Providers that can fill a role, for populating a role's dashboard selector. */
export function providersForRole(role: AiModelRole): readonly AiProviderDescriptor[] {
  return AI_PROVIDERS.filter((provider) => provider.roles[role] !== undefined);
}

/** Env keys a provider must have set before it can fill a role. */
export function requiredAiProviderEnvKeys(
  provider: AiProviderDescriptor,
  role: AiModelRole = "text_analysis",
): readonly string[] {
  const support = provider.roles[role];
  if (support === undefined) {
    return [provider.apiKeyEnvKey];
  }
  return support.defaultModel === undefined
    ? [provider.apiKeyEnvKey, support.modelEnvKey]
    : [provider.apiKeyEnvKey];
}

/** Every provider env key the dashboard is allowed to write. */
export function aiProviderEnvKeys(): readonly string[] {
  return [...new Set(AI_PROVIDERS.flatMap((provider) => [
    provider.apiKeyEnvKey,
    ...Object.values(provider.roles).map((support) => support.modelEnvKey),
    ...provider.optionalEnvKeys,
  ]))];
}

/** Env keys holding a role's provider selection. */
export function aiRoleProviderEnvKeys(): readonly string[] {
  return AI_MODEL_ROLES.map((role) => role.providerEnvKey);
}

/** Every model env key across providers and roles, for presence reporting. */
export function aiModelEnvKeys(): readonly string[] {
  return [...new Set(AI_PROVIDERS.flatMap((provider) =>
    Object.values(provider.roles).map((support) => support.modelEnvKey)))];
}

/** Provider env keys whose values must never be read back. */
export function aiProviderSecretEnvKeys(): readonly string[] {
  return [...new Set(AI_PROVIDERS.map((provider) => provider.apiKeyEnvKey))];
}

export function aiProviderIds(): readonly string[] {
  return AI_PROVIDERS.map((provider) => provider.id);
}
