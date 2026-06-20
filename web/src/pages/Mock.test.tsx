import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AuditRecord } from "../api/client.js";

const getConversation = vi.fn();
const injectMock = vi.fn();
const flushMock = vi.fn();
const getSettings = vi.fn();
const putSettings = vi.fn();

vi.mock("../api/client.js", () => ({
  api: {
    getConversation: (...args: unknown[]) => getConversation(...args),
    injectMock: (...args: unknown[]) => injectMock(...args),
    flushMock: (...args: unknown[]) => flushMock(...args),
    getSettings: (...args: unknown[]) => getSettings(...args),
    putSettings: (...args: unknown[]) => putSettings(...args),
  },
}));

const { Mock } = await import("./Mock.js");

function record(id: string): AuditRecord {
  return {
    id,
    platform: "mock",
    conversationId: "mock-chat-1",
    messageId: `mock:${id}`,
    processedAt: "2026-06-20T00:00:00.000Z",
    redactedContentPreview: "Task: ship it",
    redactionFindingCount: 0,
    steps: [{ name: "task_extraction", status: "succeeded", durationMs: 2, metadata: {} }],
    extractedTasks: [{ title: "ship it", confidence: 0.8, extractionReason: "imperative", accepted: true, syncStatus: "not_attempted", warnings: [] }],
    errorLogs: [],
    totalLatencyMs: 5,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ ok: true, settings: { conversationId: "mock-chat-1", analysisMode: "immediate" }, isDefault: false });
  injectMock.mockResolvedValue({ ok: true, results: [] });
  flushMock.mockResolvedValue({ ok: true, flushedMessageCount: 0 });
});

afterEach(cleanup);

test("sending runs the pipeline and posts a simulated bot reply with the graph mounted", async () => {
  getConversation.mockResolvedValue({ ok: true, conversationId: "mock-chat-1", records: [record("a")] });

  const { container } = render(<Mock />);
  fireEvent.click(screen.getByText("Send"));

  await waitFor(() => expect(injectMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByText(/Nocheh bot · simulated/)).toBeTruthy());
  expect(screen.getByText(/Logged 1 task: ship it/)).toBeTruthy();
  // System graph is present.
  expect(container.querySelectorAll(".graph-node").length).toBeGreaterThan(0);
});

test("clear empties the transcript and flushes the buffer", async () => {
  getConversation.mockResolvedValue({ ok: true, conversationId: "mock-chat-1", records: [record("a")] });
  vi.spyOn(window, "confirm").mockReturnValue(true);

  render(<Mock />);
  fireEvent.click(screen.getByText("Send"));
  await waitFor(() => expect(screen.getByText(/Nocheh bot · simulated/)).toBeTruthy());

  fireEvent.click(screen.getByText("Clear simulation"));
  await waitFor(() => expect(flushMock).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/No messages yet/)).toBeTruthy());
});
