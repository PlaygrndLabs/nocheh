import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Mock the whole API client so the notes page drives fakes, never the network.
const mocks = vi.hoisted(() => ({
  sendNote: vi.fn(),
  getBrainGraph: vi.fn(),
  getBrainSuggestions: vi.fn(),
  getSetupStatus: vi.fn(),
}));

vi.mock("../api/client", () => ({ api: mocks }));

const { Notes } = await import("./Notes.js");

const fakeGraph = {
  nodes: [
    { id: "person:mak", kind: "person", label: "Mak", status: "active", confidence: 1 },
    { id: "task:notes", kind: "task", label: "Release notes", status: "active", confidence: 0.8 },
  ],
  edges: [
    { id: "edge:1", fromNodeId: "person:mak", toNodeId: "task:notes", relation: "OWNS_TASK", status: "active", confidence: 0.8, fact: "Mak owns the release notes task" },
  ],
};

const fakeSuggestions = [
  {
    id: "sugg:1",
    type: "action" as const,
    kind: "task",
    title: "Close release-notes task",
    rationale: "Mak's note says the release notes are done.",
    status: "pending" as const,
    riskLevel: "low" as const,
    confidence: 0.9,
  },
];

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.sendNote.mockResolvedValue({ ok: true, result: {} });
  mocks.getBrainGraph.mockResolvedValue(fakeGraph);
  mocks.getBrainSuggestions.mockResolvedValue({ suggestions: fakeSuggestions });
  mocks.getSetupStatus.mockResolvedValue({ ok: true, hasAiKey: true, hasBotToken: false, botConnected: false, encryptionConfigured: false });
});

afterEach(cleanup);

test("sending a note calls sendNote with the typed text and refreshes the graph and suggestions", async () => {
  const { container } = render(<Notes />);
  await waitFor(() => expect(mocks.getSetupStatus).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText("Note to Nocheh"), {
    target: { value: "Close the release-notes task, it is done." },
  });
  fireEvent.click(screen.getByRole("button", { name: /Send note/ }));

  await waitFor(() => expect(mocks.sendNote).toHaveBeenCalledWith({ text: "Close the release-notes task, it is done." }));

  // The transcript records the sent note.
  await waitFor(() => expect(screen.getByText("Close the release-notes task, it is done.")).toBeTruthy());
  // The refreshed graph and suggestions render.
  await waitFor(() => expect(container.querySelectorAll(".knowledge-node").length).toBeGreaterThan(0));
  expect(screen.getByText("Close release-notes task")).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/Note sent\./)).toBeTruthy());

  expect(mocks.getBrainGraph).toHaveBeenCalled();
  expect(mocks.getBrainSuggestions).toHaveBeenCalled();
});

test("shows the dry-run notice when there is no AI key", async () => {
  mocks.getSetupStatus.mockResolvedValue({ ok: true, hasAiKey: false, hasBotToken: false, botConnected: false, encryptionConfigured: false });
  render(<Notes />);
  await waitFor(() => expect(screen.getByText(/AI is disabled \(dry-run\)/)).toBeTruthy());
});

test("persists sent notes to localStorage under nocheh.notes", async () => {
  render(<Notes />);
  await waitFor(() => expect(mocks.getSetupStatus).toHaveBeenCalled());

  fireEvent.change(screen.getByLabelText("Note to Nocheh"), { target: { value: "Remember Alice owns the mobile app." } });
  fireEvent.click(screen.getByRole("button", { name: /Send note/ }));

  await waitFor(() => expect(mocks.sendNote).toHaveBeenCalled());
  await waitFor(() => {
    const raw = localStorage.getItem("nocheh.notes");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "[]") as { text: string }[];
    expect(parsed[0]?.text).toBe("Remember Alice owns the mobile app.");
  });
});
