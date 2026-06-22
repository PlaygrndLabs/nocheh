import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FlowDiagram } from "./FlowDiagram.js";
import { FLOW_STAGES, type FlowFrame } from "../sim/flow-model.js";

afterEach(cleanup);

const frames: FlowFrame[] = [
  { stageId: "chat", status: "succeeded", durationMs: 1, headline: "new message", detail: "", metrics: [], samples: [] },
  { stageId: "receive", status: "succeeded", durationMs: 1, headline: "local only", detail: "", metrics: [], samples: [] },
  { stageId: "protect", status: "succeeded", durationMs: 1, headline: "clean", detail: "", metrics: [], samples: [] },
  { stageId: "ai_brain", status: "succeeded", durationMs: 1, headline: "understood", detail: "", metrics: [], samples: [] },
  { stageId: "memory", status: "succeeded", durationMs: 1, headline: "1 memory", detail: "", metrics: [], samples: [] },
  { stageId: "knowledge", status: "succeeded", durationMs: 1, headline: "1 nodes, 0 links", detail: "", metrics: [], samples: [] },
  { stageId: "ideas", status: "succeeded", durationMs: 1, headline: "1 idea", detail: "", metrics: [], samples: [] },
  { stageId: "tasks", status: "failed", durationMs: 1, headline: "0/1 accepted", detail: "", metrics: [], samples: [] },
  { stageId: "audit", status: "skipped", durationMs: 0, headline: "5 ms", detail: "", metrics: [], samples: [] },
];

test("renders every flow stage", () => {
  const { container, getByText } = render(<FlowDiagram frames={frames} activeIndex={-1} selectedStageId={null} onSelectStage={() => {}} />);
  expect(container.querySelectorAll(".flow-stage")).toHaveLength(FLOW_STAGES.length);
  expect(getByText("AI Brain")).toBeTruthy();
  expect(getByText("Activity log")).toBeTruthy();
});

test("colors stages by status up to the active index and marks the active stage", () => {
  // activeIndex 3 => chat..protect resolved, ai_brain active.
  const { container } = render(<FlowDiagram frames={frames} activeIndex={3} selectedStageId={null} onSelectStage={() => {}} />);
  expect(container.querySelectorAll(".flow-stage.is-succeeded").length).toBeGreaterThanOrEqual(3);
  expect(container.querySelector(".flow-stage.is-active")).toBeTruthy();
});

test("clicking a stage fires onSelectStage with its id", () => {
  const onSelectStage = vi.fn();
  const { getByText } = render(<FlowDiagram frames={frames} activeIndex={-1} selectedStageId={null} onSelectStage={onSelectStage} />);
  fireEvent.click(getByText("AI Brain"));
  expect(onSelectStage).toHaveBeenCalledWith("ai_brain");
});

test("marks the selected stage", () => {
  const { container } = render(<FlowDiagram frames={frames} activeIndex={-1} selectedStageId="ideas" onSelectStage={() => {}} />);
  expect(container.querySelector(".flow-stage.is-selected")?.textContent).toContain("Suggestions");
});
