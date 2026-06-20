import { expect, test } from "vitest";
import { render } from "@testing-library/react";
import { SystemGraph } from "./SystemGraph.js";
import { GRAPH_NODES, type TimelineFrame } from "../sim/pipeline.js";

const frames: TimelineFrame[] = [
  { nodeId: "webhook", status: "succeeded", durationMs: 1 },
  { nodeId: "secret", status: "succeeded", durationMs: 1 },
  { nodeId: "task_extract", status: "failed", durationMs: 1 },
  { nodeId: "notion_mcp", status: "skipped", durationMs: 0 },
  { nodeId: "ai", status: "simulated", durationMs: 0, simulated: true },
];

test("renders every architecture node", () => {
  const { container } = render(<SystemGraph frames={frames} activeIndex={-1} />);
  expect(container.querySelectorAll(".graph-node")).toHaveLength(GRAPH_NODES.length);
});

test("colors nodes by status up to the active index and marks the active node", () => {
  // activeIndex 2 => webhook+secret resolved, task_extract is active.
  const { container } = render(<SystemGraph frames={frames} activeIndex={2} />);
  expect(container.querySelectorAll(".graph-node.succeeded").length).toBeGreaterThanOrEqual(2);
  expect(container.querySelector(".graph-node.is-active")).toBeTruthy();
});

test("shows simulated styling once the simulated frame is active", () => {
  const { container } = render(<SystemGraph frames={frames} activeIndex={4} />);
  // The ai node is the active simulated frame.
  const ai = container.querySelector(".graph-node.sim.is-active");
  expect(ai).toBeTruthy();
});
