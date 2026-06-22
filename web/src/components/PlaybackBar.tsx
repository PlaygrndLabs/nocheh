import { Pause, Play, RotateCcw, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { stageById, type FlowFrame } from "../sim/flow-model.js";
import type { FlowPlayback } from "../sim/useFlowPlayback.js";

interface PlaybackBarProps {
  readonly playback: FlowPlayback;
  readonly frames: readonly FlowFrame[];
}

/** Manual + auto playback controls: restart, step, play/pause, and a stage scrubber. */
export function PlaybackBar({ playback, frames }: PlaybackBarProps): JSX.Element {
  const { activeIndex, isPlaying, frameCount } = playback;
  const hasFrames = frameCount > 0;
  const activeFrame = activeIndex >= 0 ? frames[activeIndex] : undefined;

  return (
    <div className="playback-bar" aria-label="Flow playback controls">
      <div className="playback-controls">
        <button type="button" title="Restart" aria-label="Restart" disabled={!hasFrames} onClick={() => playback.restart()}>
          <SkipBack size={15} aria-hidden="true" />
        </button>
        <button type="button" title="Step back" aria-label="Step back" disabled={!hasFrames || activeIndex <= 0} onClick={() => playback.stepBack()}>
          <StepBack size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="playback-play"
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
          disabled={!hasFrames}
          onClick={() => playback.toggle()}
        >
          {isPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <button type="button" title="Step forward" aria-label="Step forward" disabled={!hasFrames || activeIndex >= frameCount - 1} onClick={() => playback.stepForward()}>
          <StepForward size={15} aria-hidden="true" />
        </button>
        <button type="button" title="Jump to end" aria-label="Jump to end" disabled={!hasFrames} onClick={() => playback.seek(frameCount - 1)}>
          <SkipForward size={15} aria-hidden="true" />
        </button>
      </div>

      <input
        className="playback-scrubber"
        type="range"
        min={0}
        max={Math.max(0, frameCount - 1)}
        value={Math.max(0, activeIndex)}
        disabled={!hasFrames}
        aria-label="Flow stage scrubber"
        onChange={(event) => playback.seek(Number(event.target.value))}
      />

      <div className="playback-readout">
        {!hasFrames ? (
          <span className="muted"><RotateCcw size={13} aria-hidden="true" /> Send a message to see the flow</span>
        ) : activeFrame === undefined ? (
          <span className="muted">Ready · {frameCount} stages</span>
        ) : (
          <span>
            <b>Stage {activeIndex + 1}/{frameCount}</b> · {stageById(activeFrame.stageId).label}
            <em> — {activeFrame.headline}</em>
          </span>
        )}
      </div>
    </div>
  );
}
