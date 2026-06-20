import { afterEach, beforeEach, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSimulation } from "./useSimulation.js";
import type { AuditRecord } from "../api/client.js";

function record(id: string): AuditRecord {
  return {
    id,
    platform: "mock",
    conversationId: "chat-1",
    messageId: `mock:${id}`,
    processedAt: "2026-06-20T00:00:00.000Z",
    redactedContentPreview: "hello",
    redactionFindingCount: 0,
    steps: [],
    extractedTasks: [],
    errorLogs: [],
    totalLatencyMs: 4,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test("ingests new audit records as assistant + bot entries, deduping by id", () => {
  const { result } = renderHook(() => useSimulation("chat-1"));

  act(() => result.current.addUserEntry("Alice", "hi"));
  let added = 0;
  act(() => {
    added = result.current.ingestRecords([record("a"), record("b")]);
  });
  expect(added).toBe(2);
  // 1 user + (assistant + bot) * 2 records = 5 entries.
  expect(result.current.entries).toHaveLength(5);
  expect(result.current.entries.some((e) => e.kind === "bot")).toBe(true);

  act(() => {
    added = result.current.ingestRecords([record("a"), record("b")]);
  });
  expect(added).toBe(0);
  expect(result.current.lastAssistant?.auditId).toBe("b");
});

test("starts with a default roster and supports add/remove/select", () => {
  const { result } = renderHook(() => useSimulation("chat-1"));
  expect(result.current.members.map((m) => m.name)).toEqual(["Alice", "Bob", "You"]);

  act(() => result.current.addMember("Carol"));
  expect(result.current.members.some((m) => m.name === "Carol")).toBe(true);

  const bobId = result.current.members.find((m) => m.name === "Bob")?.id ?? "";
  act(() => result.current.setActiveMember(bobId));
  expect(result.current.activeMemberName).toBe("Bob");

  act(() => result.current.removeMember(bobId));
  expect(result.current.members.some((m) => m.name === "Bob")).toBe(false);
});

test("persists transcript and roster, restoring on reload", () => {
  const first = renderHook(() => useSimulation("chat-1"));
  act(() => first.result.current.addUserEntry("Bob", "ping"));
  act(() => first.result.current.addMember("Dave"));
  act(() => {
    first.result.current.ingestRecords([record("x")]);
  });

  const reloaded = renderHook(() => useSimulation("chat-1"));
  expect(reloaded.result.current.entries).toHaveLength(3); // user + assistant + bot
  expect(reloaded.result.current.members.some((m) => m.name === "Dave")).toBe(true);
});

test("clear empties the transcript and removes the storage key", () => {
  const { result } = renderHook(() => useSimulation("chat-1"));
  act(() => result.current.addUserEntry("Bob", "ping"));
  act(() => {
    result.current.ingestRecords([record("x")]);
  });
  expect(localStorage.getItem("nocheh.sim.chat-1")).not.toBeNull();

  act(() => result.current.clear());
  expect(result.current.entries).toHaveLength(0);
  expect(localStorage.getItem("nocheh.sim.chat-1")).toBeNull();
});
