import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AuditRecord } from "../api/client.js";

// Mock the whole API client so the simulator drives fakes, never the network.
const mocks = vi.hoisted(() => ({
  putSettings: vi.fn(),
  getSettings: vi.fn(),
  getSetupStatus: vi.fn(),
  injectMock: vi.fn(),
  flushMock: vi.fn(),
  reactMock: vi.fn(),
  sendNote: vi.fn(),
  getConversation: vi.fn(),
  getAudit: vi.fn(),
  getBrainGraph: vi.fn(),
  getBrainSuggestions: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));

const { Simulator } = await import("./Simulator.js");

const fakeRecord: AuditRecord = {
  id: "audit-run-1",
  platform: "mock",
  conversationId: "mock-chat-1",
  messageId: "batch:mock:1-mock:3",
  processedAt: "2026-06-20T00:00:00.000Z",
  redactedContentPreview: "ship the beta this week",
  redactionFindingCount: 0,
  steps: [
    { name: "telegram_message", status: "succeeded", durationMs: 1, metadata: { messageCount: 3 } },
    { name: "secret_detection", status: "succeeded", durationMs: 1, metadata: {} },
    { name: "redaction", status: "succeeded", durationMs: 1, metadata: {} },
    { name: "analysis", status: "succeeded", durationMs: 4, metadata: { nodeCount: 2, edgeCount: 1, suggestionCount: 1, warningCount: 1 } },
    { name: "memory_persistence", status: "succeeded", durationMs: 1, metadata: { recordCount: 2 } },
    { name: "graph_persistence", status: "succeeded", durationMs: 1, metadata: { nodeCount: 2, edgeCount: 1 } },
    { name: "suggestion_persistence", status: "succeeded", durationMs: 1, metadata: { suggestionCount: 1 } },
    { name: "validation", status: "succeeded", durationMs: 1, metadata: { acceptedCount: 1, warningCount: 0 } },
  ],
  extractedTasks: [
    { title: "prepare release notes", confidence: 0.8, extractionReason: "commitment", accepted: true, syncStatus: "not_attempted", warnings: [] },
  ],
  errorLogs: [],
  totalLatencyMs: 12,
  aiTokenUsage: { provider: "anthropic", model: "claude-sonnet", inputTokens: 900, outputTokens: 210, totalTokens: 1110 },
};

const fakeGraph = {
  nodes: [
    { id: "person:mak", kind: "person", label: "Mak", status: "active", confidence: 1 },
    { id: "goal:beta", kind: "goal", label: "Ship beta", status: "active", confidence: 0.82 },
  ],
  edges: [
    { id: "edge:1", fromNodeId: "person:mak", toNodeId: "goal:beta", relation: "SUPPORTS_GOAL", status: "active", confidence: 0.82, fact: "Mak wants to ship the beta" },
  ],
};

const fakeSuggestions = [
  {
    id: "sugg:1",
    type: "strategic" as const,
    kind: "goal",
    title: "Lock pricing before launch",
    rationale: "Pricing with the partner is the real blocker before shipping the beta.",
    status: "pending" as const,
    riskLevel: "medium" as const,
    confidence: 0.78,
  },
];

const fakeSettings = {
  conversationId: "mock-chat-1",
  analysisMode: "batch" as const,
  analysisIntervalSeconds: 86400,
  maxMessagesPerBatch: 100,
  maxAiContextTokens: 8000,
  maxRetrievedMemories: 12,
  maxRecentMessages: 40,
  summaryEveryMessages: 50,
  summaryEveryMinutes: 60,
  replyMode: "silent" as const,
  projectHint: "single" as const,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.putSettings.mockResolvedValue({ ok: true, settings: {} });
  mocks.getSettings.mockResolvedValue({ ok: true, settings: fakeSettings, isDefault: true });
  mocks.getSetupStatus.mockResolvedValue({ ok: true, hasAiKey: true, hasBotToken: false, botConnected: false, encryptionConfigured: false });
  mocks.injectMock.mockResolvedValue({ ok: true, results: [] });
  mocks.flushMock.mockResolvedValue({ ok: true, flushedMessageCount: 1 });
  mocks.reactMock.mockResolvedValue({ ok: true, result: { statusUpdateCount: 1 } });
  mocks.sendNote.mockResolvedValue({ ok: true, result: {} });
  mocks.getConversation.mockResolvedValue({ ok: true, conversationId: "mock-chat-1", records: [fakeRecord] });
  mocks.getAudit.mockResolvedValue({ ok: true, records: [fakeRecord] });
  mocks.getBrainGraph.mockResolvedValue(fakeGraph);
  mocks.getBrainSuggestions.mockResolvedValue({ suggestions: fakeSuggestions });
});

afterEach(cleanup);

test("configures batch mode on mount (with the group's projectHint) and shows the live AI status", async () => {
  render(<Simulator />);
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledWith("mock-chat-1"));
  await waitFor(() => expect(mocks.putSettings).toHaveBeenCalledWith("mock-chat-1", {
    analysisMode: "batch",
    analysisIntervalSeconds: 86400,
    maxMessagesPerBatch: 100,
    projectHint: "single",
  }));
  await waitFor(() => expect(screen.getByText("live")).toBeTruthy());
  expect(screen.queryByText(/AI is disabled/)).toBeNull();
});

test("switching project mode to multi persists the projectHint for the active group", async () => {
  render(<Simulator />);
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledWith("mock-chat-1"));
  await waitFor(() => expect(screen.getByRole("radio", { name: "Single" }).getAttribute("aria-checked")).toBe("true"));

  fireEvent.click(screen.getByRole("radio", { name: "Multi" }));

  await waitFor(() => expect(mocks.putSettings).toHaveBeenCalledWith("mock-chat-1", { projectHint: "multi" }));
  await waitFor(() => expect(screen.getByText(/Project mode set to multi/)).toBeTruthy());
});

test("adding a group switches the active conversation and loads its settings", async () => {
  render(<Simulator />);
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledWith("mock-chat-1"));

  fireEvent.change(screen.getByLabelText("New group name"), { target: { value: "Marketing" } });
  fireEvent.click(screen.getByRole("button", { name: "Add group" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Marketing" })).toBeTruthy());
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledWith("mock-marketing"));
});

test("sending buffers a message and updates the pending counter", async () => {
  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(mocks.injectMock).toHaveBeenCalled());
  const call = mocks.injectMock.mock.calls[0]?.[0] as { conversationId: string; messageId: string }[];
  expect(call[0]?.conversationId).toBe("mock-chat-1");
  expect(call[0]?.messageId).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/pending \(buffered\): 1/)).toBeTruthy());
});

test("run analysis flushes, fetches real results, and renders the flow", async () => {
  const { container } = render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(mocks.injectMock).toHaveBeenCalled());

  fireEvent.click(screen.getByRole("button", { name: /Run analysis/ }));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  expect(mocks.flushMock).toHaveBeenCalledWith("mock-chat-1");
  expect(mocks.getConversation).toHaveBeenCalledWith("mock-chat-1");
  expect(mocks.getBrainGraph).toHaveBeenCalled();
  expect(mocks.getBrainSuggestions).toHaveBeenCalled();
  expect(container.querySelectorAll(".flow-stage").length).toBeGreaterThan(0);
  expect(screen.getAllByText("AI Brain").length).toBeGreaterThan(0);
});

test("what-Nocheh-noticed tab renders real pending suggestions", async () => {
  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(mocks.injectMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /Run analysis/ }));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  fireEvent.click(screen.getByRole("tab", { name: /What Nocheh noticed/ }));
  await waitFor(() => expect(screen.getByText("Lock pricing before launch")).toBeTruthy());
  expect(screen.getByText(/real blocker before shipping/)).toBeTruthy();
});

test("knowledge tab renders the real backend graph", async () => {
  const { container } = render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(mocks.injectMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /Run analysis/ }));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  fireEvent.click(screen.getByRole("tab", { name: /Knowledge graph/ }));
  await waitFor(() => expect(container.querySelector(".knowledge-graph")).toBeTruthy());
  expect(container.querySelectorAll(".knowledge-node").length).toBeGreaterThan(0);
});

test("dry-run mode shows the AI disabled notice", async () => {
  mocks.getSetupStatus.mockResolvedValue({ ok: true, hasAiKey: false, hasBotToken: false, botConnected: false, encryptionConfigured: false });
  render(<Simulator />);
  await waitFor(() => expect(screen.getByText(/AI is disabled \(dry-run\)/)).toBeTruthy());
});

test("clear empties only the local transcript and says the backend was untouched", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(mocks.injectMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /Run analysis/ }));
  await waitFor(() => expect(screen.getByText(/Nocheh system result/)).toBeTruthy());

  fireEvent.click(screen.getByText("Clear"));
  await waitFor(() => expect(screen.getByText(/No messages yet/)).toBeTruthy());
  expect(screen.getByText(/Backend brain data was not changed/)).toBeTruthy();
});

test("reacting on a user message calls reactMock with the message id and shows the update notice", async () => {
  render(<Simulator />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.getByText(/pending \(buffered\): 1/)).toBeTruthy());

  const injected = mocks.injectMock.mock.calls[0]?.[0] as { messageId: string }[];
  const messageId = injected[0]?.messageId ?? "";
  expect(messageId).not.toBe("");

  fireEvent.click(screen.getByRole("button", { name: "React with \u2705" }));
  await waitFor(() => expect(mocks.reactMock).toHaveBeenCalled());

  const reactCall = mocks.reactMock.mock.calls[0]?.[0] as {
    conversationId: string;
    targetMessageId: string;
    emoji: string;
    reactorId: string;
    reactorDisplayName: string;
  };
  expect(reactCall.conversationId).toBe("mock-chat-1");
  expect(reactCall.targetMessageId).toBe(messageId);
  expect(reactCall.emoji).toBe("\u2705");
  expect(reactCall.reactorDisplayName).toBe("Alice");

  await waitFor(() => expect(screen.getByText(/Reaction updated 1 item/)).toBeTruthy());
});

test("the note composer sends an out-of-band note for the active conversation and shows a notice", async () => {
  render(<Simulator />);
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledWith("mock-chat-1"));

  fireEvent.click(screen.getByText(/Send a note to Nocheh/));
  fireEvent.change(screen.getByLabelText("Note to Nocheh"), {
    target: { value: "Close the release-notes task, it is done." },
  });
  fireEvent.click(screen.getByRole("button", { name: /Send note/ }));

  await waitFor(() => expect(mocks.sendNote).toHaveBeenCalledWith({
    conversationId: "mock-chat-1",
    text: "Close the release-notes task, it is done.",
  }));
  expect(mocks.getBrainGraph).toHaveBeenCalled();
  expect(mocks.getBrainSuggestions).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText(/Note sent to Nocheh as an out-of-band instruction/)).toBeTruthy());
});

test("reacting in dry-run mode explains that nothing changed", async () => {
  mocks.getSetupStatus.mockResolvedValue({ ok: true, hasAiKey: false, hasBotToken: false, botConnected: false, encryptionConfigured: false });
  mocks.reactMock.mockResolvedValue({ ok: true, result: { statusUpdateCount: 0 } });

  render(<Simulator />);
  await waitFor(() => expect(screen.getByText(/AI is disabled \(dry-run\)/)).toBeTruthy());
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.getByText(/pending \(buffered\): 1/)).toBeTruthy());

  fireEvent.click(screen.getByRole("button", { name: "React with \u2705" }));
  await waitFor(() => expect(mocks.reactMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/dry-run mode so nothing changed/)).toBeTruthy());
});
