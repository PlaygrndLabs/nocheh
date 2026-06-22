import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StageInspector } from "./StageInspector.js";
import { buildBrainPreview } from "../sim/brain-preview.js";
import { stageById, type FlowFrame } from "../sim/flow-model.js";
import type { AuditRecord } from "../api/client.js";

afterEach(cleanup);

const preview = buildBrainPreview([]);

function frame(overrides: Partial<FlowFrame> & Pick<FlowFrame, "stageId">): FlowFrame {
  return { status: "succeeded", durationMs: 1, headline: "", detail: "did the thing", metrics: [], samples: [], ...overrides };
}

test("shows 'not reached yet' when the frame is undefined", () => {
  const { getByText } = render(<StageInspector stage={stageById("ideas")} frame={undefined} record={undefined} preview={preview} />);
  expect(getByText(/not reached yet/)).toBeTruthy();
  expect(getByText(/has not run yet/)).toBeTruthy();
});

test("renders the approval property for the suggestions stage", () => {
  const { getByText } = render(<StageInspector stage={stageById("ideas")} frame={frame({ stageId: "ideas" })} record={undefined} preview={preview} />);
  expect(getByText(/approval/i)).toBeTruthy();
});

test("highlights redacted spans for the protect stage", () => {
  const record = {
    redactedContentPreview: "my key is [REDACTED] ok",
    redactionFindingCount: 1,
  } as AuditRecord;
  const { getByText, container } = render(
    <StageInspector stage={stageById("protect")} frame={frame({ stageId: "protect" })} record={record} preview={preview} />,
  );
  expect(getByText(/Redacted preview/)).toBeTruthy();
  expect(container.querySelector(".redacted-span")).toBeTruthy();
});

test("renders metrics and samples", () => {
  const { getByText } = render(
    <StageInspector
      stage={stageById("tasks")}
      frame={frame({ stageId: "tasks", metrics: [{ label: "Accepted", value: 2 }], samples: ["ship it — 0.80 accepted"] })}
      record={undefined}
      preview={preview}
    />,
  );
  expect(getByText("Accepted")).toBeTruthy();
  expect(getByText(/ship it/)).toBeTruthy();
});
