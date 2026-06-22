import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PlaybackBar } from "./PlaybackBar.js";
import type { FlowFrame } from "../sim/flow-model.js";
import type { FlowPlayback } from "../sim/useFlowPlayback.js";

afterEach(cleanup);

const frames: FlowFrame[] = [
  { stageId: "chat", status: "succeeded", durationMs: 1, headline: "new message", detail: "", metrics: [], samples: [] },
  { stageId: "receive", status: "succeeded", durationMs: 1, headline: "local only", detail: "", metrics: [], samples: [] },
  { stageId: "protect", status: "succeeded", durationMs: 1, headline: "clean", detail: "", metrics: [], samples: [] },
];

function playback(overrides: Partial<FlowPlayback> = {}): FlowPlayback {
  return {
    activeIndex: 1,
    isPlaying: false,
    frameCount: frames.length,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    stepForward: vi.fn(),
    stepBack: vi.fn(),
    seek: vi.fn(),
    restart: vi.fn(),
    ...overrides,
  };
}

test("shows the empty hint when there are no frames", () => {
  const { getByText } = render(<PlaybackBar playback={playback({ frameCount: 0, activeIndex: -1 })} frames={[]} />);
  expect(getByText(/Send a message to see the flow/)).toBeTruthy();
});

test("play button toggles playback", () => {
  const pb = playback();
  const { getByLabelText } = render(<PlaybackBar playback={pb} frames={frames} />);
  fireEvent.click(getByLabelText("Play"));
  expect(pb.toggle).toHaveBeenCalled();
});

test("scrubber seeks to the dragged index", () => {
  const pb = playback();
  const { getByLabelText } = render(<PlaybackBar playback={pb} frames={frames} />);
  fireEvent.change(getByLabelText("Flow stage scrubber"), { target: { value: "2" } });
  expect(pb.seek).toHaveBeenCalledWith(2);
});

test("step back is disabled at the start", () => {
  const { getByLabelText } = render(<PlaybackBar playback={playback({ activeIndex: 0 })} frames={frames} />);
  expect((getByLabelText("Step back") as HTMLButtonElement).disabled).toBe(true);
});

test("reads out the current stage", () => {
  const { getByText } = render(<PlaybackBar playback={playback({ activeIndex: 2 })} frames={frames} />);
  expect(getByText(/Stage 3\/3/)).toBeTruthy();
});
