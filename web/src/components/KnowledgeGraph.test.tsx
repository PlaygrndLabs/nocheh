import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { KnowledgeGraph } from "./KnowledgeGraph.js";

test("renders knowledge nodes and relation labels", () => {
  render(
    <KnowledgeGraph
      nodes={[
        { id: "mak", kind: "person", label: "Mak" },
        { id: "goal:x", kind: "goal", label: "Grow X page" },
      ]}
      edges={[
        { id: "edge:1", fromNodeId: "mak", toNodeId: "goal:x", relation: "SUPPORTS_GOAL" },
      ]}
      emptyMessage="No graph"
    />,
  );

  // Labels render as SVG <text>; the node also carries a <title> tooltip with the same text.
  const labelText = (text: string): HTMLElement[] =>
    screen.getAllByText(text).filter((el) => el.classList.contains("knowledge-node-label"));
  expect(labelText("Mak")).toHaveLength(1);
  expect(labelText("Grow X page")).toHaveLength(1);
  expect(screen.getByText("Supports Goal")).toBeTruthy();
});

test("renders an empty state when no nodes exist", () => {
  render(<KnowledgeGraph nodes={[]} edges={[]} emptyMessage="No knowledge yet" />);

  expect(screen.getByText("No knowledge yet")).toBeTruthy();
});
