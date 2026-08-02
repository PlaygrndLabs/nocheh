import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock the whole API client so the setup page drives fakes, never the network.
const mocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  putEnv: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));

const { Setup } = await import("./Setup.js");

const textProviders = [
  {
    id: "nvidia",
    label: "NVIDIA API Catalog",
    apiKeyEnvKey: "NVIDIA_API_KEY",
    modelEnvKey: "NVIDIA_MODEL",
    defaultModel: "z-ai/glm-5.2",
    modelRequired: false,
    notes: "GLM-5.2. Text only; it cannot read images or audio.",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiKeyEnvKey: "ANTHROPIC_API_KEY",
    modelEnvKey: "ANTHROPIC_MODEL",
    modelRequired: true,
    notes: "Anthropic Messages API. Model id is required. Key format sk-ant-...",
  },
];

const mediaProviders = [
  {
    id: "nvidia",
    label: "NVIDIA API Catalog",
    apiKeyEnvKey: "NVIDIA_API_KEY",
    modelEnvKey: "NVIDIA_MEDIA_MODEL",
    defaultModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    modelRequired: false,
    notes: "Omni model: handles image and audio in one request.",
  },
];

const guardProviders = [
  {
    id: "gemini",
    label: "Google Gemini",
    apiKeyEnvKey: "GEMINI_API_KEY",
    modelEnvKey: "GEMINI_GUARD_MODEL",
    modelRequired: true,
    notes: "Prefer a small, fast model: the guard runs once per window.",
  },
];

const providerSummaries = [
  {
    id: "nvidia",
    label: "NVIDIA API Catalog",
    apiKeyEnvKey: "NVIDIA_API_KEY",
    hasApiKey: false,
    notes: "OpenAI-compatible endpoint at integrate.api.nvidia.com.",
    roles: ["text_analysis", "media_understanding", "secret_guard"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    apiKeyEnvKey: "GEMINI_API_KEY",
    hasApiKey: false,
    notes: "Gemini generateContent API.",
    roles: ["text_analysis", "media_understanding", "secret_guard"],
  },
];

function role(
  id: string,
  label: string,
  providerEnvKey: string,
  providers: typeof textProviders,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    label,
    purpose: `${label} purpose`,
    whenUnset: `${label} disabled`,
    providerEnvKey,
    provider: "none",
    supported: false,
    ready: false,
    providers,
    ...overrides,
  };
}

const dryRunStatus = {
  ok: true,
  hasAiKey: false,
  aiProvider: "none",
  roles: [
    role("text_analysis", "Text analysis", "AI_PROVIDER", textProviders),
    role("media_understanding", "Image and voice understanding", "AI_MEDIA_PROVIDER", mediaProviders),
    role("secret_guard", "Secret guard", "AI_GUARD_PROVIDER", guardProviders),
  ],
  providers: providerSummaries,
  hasBotToken: false,
  botConnected: false,
  encryptionConfigured: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetupStatus.mockResolvedValue(dryRunStatus);
  mocks.putEnv.mockResolvedValue({ ok: true, updated: [], rejected: [] });
});

afterEach(cleanup);

test("a provider credential is saved once and shared across roles", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("NVIDIA_API_KEY")).toBeTruthy());

  fireEvent.change(screen.getByLabelText("NVIDIA_API_KEY"), { target: { value: " nvapi-secret " } });
  fireEvent.click(screen.getByRole("button", { name: /Save NVIDIA API Catalog key/ }));

  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({ NVIDIA_API_KEY: "nvapi-secret" }));
});

test("saving the text role without a model relies on the catalog default", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("AI_PROVIDER")).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: /Save text analysis/ }));

  // No NVIDIA_MODEL key is written, so the backend default (z-ai/glm-5.2) applies.
  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({ AI_PROVIDER: "nvidia" }));
  expect(screen.getByText(/saved to \.env \(model: z-ai\/glm-5\.2\)/)).toBeTruthy();
});

test("an explicit model overrides the default", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText(/NVIDIA_MODEL/)).toBeTruthy());

  fireEvent.change(screen.getByLabelText(/NVIDIA_MODEL/), { target: { value: "z-ai/glm-5.1" } });
  fireEvent.click(screen.getByRole("button", { name: /Save text analysis/ }));

  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({
    AI_PROVIDER: "nvidia",
    NVIDIA_MODEL: "z-ai/glm-5.1",
  }));
});

test("switching provider swaps the model env key and requires a model when there is no default", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("AI_PROVIDER")).toBeTruthy());

  fireEvent.change(screen.getByLabelText("AI_PROVIDER"), { target: { value: "anthropic" } });

  // Anthropic has no default model, so saving stays blocked until one is given.
  expect(screen.getByRole("button", { name: /Save text analysis/ }).hasAttribute("disabled")).toBe(true);

  fireEvent.change(screen.getByLabelText("ANTHROPIC_MODEL"), { target: { value: "claude-sonnet-test" } });
  fireEvent.click(screen.getByRole("button", { name: /Save text analysis/ }));

  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({
    AI_PROVIDER: "anthropic",
    ANTHROPIC_MODEL: "claude-sonnet-test",
  }));
});

test("the api key input never renders the secret in clear text and is not prefilled", async () => {
  render(<Setup />);
  const input = await waitFor(() => screen.getByLabelText("NVIDIA_API_KEY") as HTMLInputElement);
  expect(input.value).toBe("");
  expect(input.type).toBe("password");
  expect(input.autocomplete).toBe("off");
});

test("each role reports its own provider and model", async () => {
  mocks.getSetupStatus.mockResolvedValue({
    ...dryRunStatus,
    hasAiKey: true,
    aiProvider: "nvidia",
    aiModel: "z-ai/glm-5.2",
    roles: [
      role("text_analysis", "Text analysis", "AI_PROVIDER", textProviders, {
        provider: "nvidia",
        supported: true,
        ready: true,
        model: "z-ai/glm-5.2",
      }),
      role("media_understanding", "Image and voice understanding", "AI_MEDIA_PROVIDER", mediaProviders, {
        provider: "nvidia",
        supported: true,
        ready: true,
        model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      }),
      role("secret_guard", "Secret guard", "AI_GUARD_PROVIDER", guardProviders),
    ],
  });

  render(<Setup />);
  await waitFor(() => expect(screen.getByText("z-ai/glm-5.2")).toBeTruthy());
  expect(screen.getByText("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")).toBeTruthy();
});

test("the media role saves its own provider env key and role-scoped model key", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("AI_MEDIA_PROVIDER")).toBeTruthy());

  fireEvent.change(screen.getByLabelText(/NVIDIA_MEDIA_MODEL/), { target: { value: "custom-omni" } });
  fireEvent.click(screen.getByRole("button", { name: /Save image and voice understanding/ }));

  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({
    AI_MEDIA_PROVIDER: "nvidia",
    NVIDIA_MEDIA_MODEL: "custom-omni",
  }));
});

test("a role warns when its provider credential is missing", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("AI_GUARD_PROVIDER")).toBeTruthy());

  expect(screen.getByText(/GEMINI_API_KEY is not set yet/)).toBeTruthy();
});
