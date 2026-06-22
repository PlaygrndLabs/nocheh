import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useFlowPlayback, type FlowPlayback } from "./useFlowPlayback.js";
import type { FlowFrame } from "./flow-model.js";

const frames: FlowFrame[] = [
  { stageId: "chat", status: "succeeded", durationMs: 300, headline: "", detail: "", metrics: [], samples: [] },
  { stageId: "receive", status: "succeeded", durationMs: 300, headline: "", detail: "", metrics: [], samples: [] },
  { stageId: "protect", status: "succeeded", durationMs: 300, headline: "", detail: "", metrics: [], samples: [] },
];

let captured: FlowPlayback;

function Harness({ frames: input }: { readonly frames: readonly FlowFrame[] }): null {
  captured = useFlowPlayback(input);
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("starts idle at -1", () => {
  render(<Harness frames={frames} />);
  expect(captured.activeIndex).toBe(-1);
  expect(captured.isPlaying).toBe(false);
});

test("restart plays from 0 and advances on the timer", () => {
  render(<Harness frames={frames} />);
  act(() => captured.restart());
  expect(captured.activeIndex).toBe(0);
  expect(captured.isPlaying).toBe(true);
  act(() => { vi.advanceTimersByTime(350); });
  expect(captured.activeIndex).toBe(1);
});

test("pause stops advancing", () => {
  render(<Harness frames={frames} />);
  act(() => captured.restart());
  act(() => captured.pause());
  expect(captured.isPlaying).toBe(false);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(captured.activeIndex).toBe(0);
});

test("seek jumps to an index and pauses", () => {
  render(<Harness frames={frames} />);
  act(() => captured.restart());
  act(() => captured.seek(2));
  expect(captured.activeIndex).toBe(2);
  expect(captured.isPlaying).toBe(false);
});

test("step forward and back clamp at bounds", () => {
  render(<Harness frames={frames} />);
  act(() => captured.seek(2));
  act(() => captured.stepForward());
  expect(captured.activeIndex).toBe(2);
  act(() => captured.stepBack());
  expect(captured.activeIndex).toBe(1);
});

test("resets when frames change", () => {
  const { rerender } = render(<Harness frames={frames} />);
  act(() => captured.seek(2));
  rerender(<Harness frames={[...frames]} />);
  expect(captured.activeIndex).toBe(-1);
});
