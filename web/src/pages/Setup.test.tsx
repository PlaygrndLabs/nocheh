import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock the whole API client so the setup page drives fakes, never the network.
const mocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  putEnv: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));

const { Setup } = await import("./Setup.js");

const providers = [
  {
    id: "nvidia",
    label: "NVIDIA API Catalog (GLM-5.2)",
    apiKeyEnvKey: "NVIDIA_API_KEY",
    modelEnvKey: "NVIDIA_MODEL",
    defaultModel: "z-ai/glm-5.2",
    modelRequired: false,
    notes: "OpenAI-compatible endpoint at integrate.api.nvidia.com. Key format nvapi-...",
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

const dryRunStatus = {
  ok: true,
  hasAiKey: false,
  aiProvider: "none",
  providers,
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

test("saving NVIDIA without a model relies on the catalog default", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("NVIDIA_API_KEY")).toBeTruthy());

  fireEvent.change(screen.getByLabelText("NVIDIA_API_KEY"), { target: { value: " nvapi-secret " } });
  fireEvent.click(screen.getByRole("button", { name: /Save provider/ }));

  // No NVIDIA_MODEL key is written, so the backend default (z-ai/glm-5.2) applies.
  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({
    AI_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "nvapi-secret",
  }));
  expect(screen.getByText(/saved to \.env \(model: z-ai\/glm-5\.2\)/)).toBeTruthy();
});

test("an explicit model overrides the default", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("NVIDIA_API_KEY")).toBeTruthy());

  fireEvent.change(screen.getByLabelText("NVIDIA_API_KEY"), { target: { value: "nvapi-secret" } });
  fireEvent.change(screen.getByLabelText(/NVIDIA_MODEL/), { target: { value: "z-ai/glm-5.1" } });
  fireEvent.click(screen.getByRole("button", { name: /Save provider/ }));

  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({
    AI_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "nvapi-secret",
    NVIDIA_MODEL: "z-ai/glm-5.1",
  }));
});

test("switching provider swaps the env keys and requires a model when there is no default", async () => {
  render(<Setup />);
  await waitFor(() => expect(screen.getByLabelText("NVIDIA_API_KEY")).toBeTruthy());

  fireEvent.change(screen.getByLabelText("AI_PROVIDER"), { target: { value: "anthropic" } });
  fireEvent.change(screen.getByLabelText("ANTHROPIC_API_KEY"), { target: { value: "sk-ant-secret" } });

  // Anthropic has no default model, so saving stays blocked until one is given.
  expect(screen.getByRole("button", { name: /Save provider/ }).hasAttribute("disabled")).toBe(true);

  fireEvent.change(screen.getByLabelText("ANTHROPIC_MODEL"), { target: { value: "claude-sonnet-test" } });
  fireEvent.click(screen.getByRole("button", { name: /Save provider/ }));

  await waitFor(() => expect(mocks.putEnv).toHaveBeenCalledWith({
    AI_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-secret",
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

test("the active provider and model are shown once configured", async () => {
  mocks.getSetupStatus.mockResolvedValue({
    ...dryRunStatus,
    hasAiKey: true,
    aiProvider: "nvidia",
    aiModel: "z-ai/glm-5.2",
  });

  render(<Setup />);
  await waitFor(() => expect(screen.getByText("nvidia")).toBeTruthy());
  expect(screen.getByText("z-ai/glm-5.2")).toBeTruthy();
});
