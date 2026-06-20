import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { PipelineTrace } from "./PipelineTrace.js";
import type { AuditRecord } from "../api/client.js";

const record: AuditRecord = {
  id: "audit-1",
  platform: "mock",
  conversationId: "chat-1",
  messageId: "mock:1",
  processedAt: "2026-06-20T00:00:00.000Z",
  redactedContentPreview: "Task: ship the report",
  redactionFindingCount: 0,
  steps: [
    { name: "task_extraction", status: "succeeded", durationMs: 3, metadata: { count: 1 } },
    { name: "notion_sync", status: "skipped", durationMs: 0, metadata: {} },
  ],
  extractedTasks: [
    { title: "ship the report", confidence: 0.82, extractionReason: "imperative", accepted: true, syncStatus: "not_attempted", warnings: [] },
  ],
  errorLogs: [],
  totalLatencyMs: 5,
};

test("renders pipeline steps and extracted tasks from a record", () => {
  render(<PipelineTrace records={[record]} />);

  expect(screen.getByText("task_extraction")).toBeTruthy();
  expect(screen.getByText("notion_sync")).toBeTruthy();
  expect(screen.getByText(/ship the report \[0\.82/)).toBeTruthy();
});

test("shows an empty message when there are no records", () => {
  render(<PipelineTrace records={[]} />);

  expect(screen.getByText(/No processed messages/)).toBeTruthy();
});
