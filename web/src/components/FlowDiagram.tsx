import { useMemo, useRef, useState, type Dispatch, type MutableRefObject, type PointerEvent, type SetStateAction, type WheelEvent } from "react";
import { linkHorizontal, range, scalePoint } from "d3";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
  FLOW_EDGES,
  FLOW_STAGES,
  STAGE_ORDER,
  STORE_STAGES,
  type FlowFrame,
  type FlowStage,
  type StageId,
  type StageStatus,
} from "../sim/flow-model.js";

const CANVAS_W = 1000;
const CANVAS_H = 440;
const NODE_W = 138;
const NODE_H = 62;
const MARGIN_X = 16;
const MARGIN_Y = 14;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 1.8;
const ZOOM_STEP = 0.12;

interface FlowDiagramProps {
  readonly frames: readonly FlowFrame[];
  readonly activeIndex: number;
  readonly selectedStageId: StageId | null;
  onSelectStage(id: StageId): void;
}

interface PlacedStage extends FlowStage {
  /** Center coordinates on the canvas. */
  readonly cx: number;
  readonly cy: number;
}

/** d3-driven swimlane flow diagram: deterministic layout, animated edges, clickable stages. */
export function FlowDiagram({ frames, activeIndex, selectedStageId, onSelectStage }: FlowDiagramProps): JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ readonly pointerId: number; readonly x: number; readonly y: number } | null>(null);

  const stages = useMemo(() => layoutStages(), []);
  const placedById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);

  const statusByStage = useMemo(() => computeStatuses(frames, activeIndex), [frames, activeIndex]);
  const activeStageId = activeIndex >= 0 ? frames[activeIndex]?.stageId : undefined;
  const activeOrdinal = activeStageId === undefined ? -1 : STAGE_ORDER.indexOf(activeStageId);

  const link = useMemo(() => linkHorizontal<unknown, { readonly x: number; readonly y: number }>().x((d) => d.x).y((d) => d.y), []);

  return (
    <div
      className="flow-diagram"
      onPointerDown={(event) => startPan(event, dragRef)}
      onPointerMove={(event) => movePan(event, dragRef, setPan)}
      onPointerUp={(event) => endPan(event, dragRef)}
      onPointerCancel={(event) => endPan(event, dragRef)}
      onWheel={(event) => wheelZoom(event, setZoom)}
    >
      <div className="graph-toolbar" aria-label="Diagram controls">
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((value) => clamp(value - ZOOM_STEP))}>
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((value) => clamp(value + ZOOM_STEP))}>
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button type="button" title="Reset view" aria-label="Reset view" onClick={() => {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}>
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      </div>

      <div
        className="flow-canvas"
        style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})` }}
      >
        <svg className="flow-svg" viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {FLOW_EDGES.map((edge) => {
            const from = placedById.get(edge.from);
            const to = placedById.get(edge.to);
            if (from === undefined || to === undefined) {
              return null;
            }
            const toOrdinal = STAGE_ORDER.indexOf(edge.to);
            const isActive = edge.to === activeStageId;
            const isTraversed = activeOrdinal >= 0 && toOrdinal <= activeOrdinal;
            const d = link({ source: edgeAnchor(from, "out"), target: edgeAnchor(to, "in") }) ?? "";
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                className={`flow-edge${isActive ? " is-active" : ""}${!isActive && isTraversed ? " is-traversed" : ""}`}
                d={d}
                fill="none"
              />
            );
          })}
        </svg>

        <div className="flow-nodes" role="list" aria-label="System flow stages">
          {stages.map((stage) => {
            const status = statusByStage.get(stage.id) ?? "idle";
            const isActive = stage.id === activeStageId;
            const isSelected = stage.id === selectedStageId;
            const frame = frameFor(frames, stage.id);
            return (
              <button
                key={stage.id}
                type="button"
                role="listitem"
                className={`flow-stage lane-${stage.lane} is-${status}${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                style={{
                  left: `${((stage.cx - NODE_W / 2) / CANVAS_W) * 100}%`,
                  top: `${((stage.cy - NODE_H / 2) / CANVAS_H) * 100}%`,
                  width: `${(NODE_W / CANVAS_W) * 100}%`,
                }}
                onClick={() => onSelectStage(stage.id)}
                aria-pressed={isSelected}
                title={`${stage.label}: ${status}`}
              >
                <span className="flow-stage-label">{stage.label}</span>
                <span className="flow-stage-sublabel">{stage.sublabel}</span>
                {frame !== undefined && status !== "idle" && (
                  <span className="flow-stage-headline">{frame.headline}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Spine + fan + collector layout: the input→process stages run along a
 * horizontal centre spine, the four stores fan out across the full canvas
 * height in their column, and the audit log collects them back at centre.
 */
function layoutStages(): readonly PlacedStage[] {
  const maxColumn = Math.max(...FLOW_STAGES.map((stage) => stage.column));
  const columnScale = scalePoint<number>()
    .domain(range(maxColumn + 1))
    .range([MARGIN_X + NODE_W / 2, CANVAS_W - MARGIN_X - NODE_W / 2])
    .padding(0);

  // Stores spread across the full height in their column so they never overlap.
  const storeScale = scalePoint<StageId>()
    .domain([...STORE_STAGES])
    .range([MARGIN_Y + NODE_H / 2, CANVAS_H - MARGIN_Y - NODE_H / 2])
    .padding(0);

  return FLOW_STAGES.map((stage) => ({
    ...stage,
    cx: columnScale(stage.column) ?? CANVAS_W / 2,
    cy: stage.lane === "stores" ? storeScale(stage.id) ?? CANVAS_H / 2 : CANVAS_H / 2,
  }));
}

/** Anchor point on a node edge for connecting links (right side out, left side in). */
function edgeAnchor(stage: PlacedStage, side: "in" | "out"): { readonly x: number; readonly y: number } {
  return { x: stage.cx + (side === "out" ? NODE_W / 2 : -NODE_W / 2), y: stage.cy };
}

function frameFor(frames: readonly FlowFrame[], stageId: StageId): FlowFrame | undefined {
  return frames.find((frame) => frame.stageId === stageId);
}

/** Resolves each stage's status from the frames played so far. */
function computeStatuses(frames: readonly FlowFrame[], activeIndex: number): Map<StageId, StageStatus | "active" | "idle"> {
  const result = new Map<StageId, StageStatus | "active" | "idle">();
  if (activeIndex < 0) {
    return result;
  }
  for (let index = 0; index <= activeIndex && index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) {
      continue;
    }
    result.set(frame.stageId, index === activeIndex ? "active" : frame.status);
  }
  return result;
}

function startPan(
  event: PointerEvent<HTMLDivElement>,
  dragRef: MutableRefObject<{ readonly pointerId: number; readonly x: number; readonly y: number } | null>,
): void {
  if ((event.target as HTMLElement).closest(".graph-toolbar") !== null || (event.target as HTMLElement).closest(".flow-stage") !== null) {
    return;
  }
  event.currentTarget.setPointerCapture(event.pointerId);
  dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
}

function movePan(
  event: PointerEvent<HTMLDivElement>,
  dragRef: MutableRefObject<{ readonly pointerId: number; readonly x: number; readonly y: number } | null>,
  setPan: Dispatch<SetStateAction<{ readonly x: number; readonly y: number }>>,
): void {
  const drag = dragRef.current;
  if (drag === null || drag.pointerId !== event.pointerId) {
    return;
  }
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
}

function endPan(
  event: PointerEvent<HTMLDivElement>,
  dragRef: MutableRefObject<{ readonly pointerId: number; readonly x: number; readonly y: number } | null>,
): void {
  if (dragRef.current?.pointerId === event.pointerId) {
    dragRef.current = null;
  }
}

function wheelZoom(event: WheelEvent<HTMLDivElement>, setZoom: Dispatch<SetStateAction<number>>): void {
  event.preventDefault();
  const direction = event.deltaY > 0 ? -1 : 1;
  setZoom((value) => clamp(value + direction * ZOOM_STEP));
}

function clamp(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}
