import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineFrame } from "./pipeline.js";

const MIN_FRAME_MS = 250;
const MAX_FRAME_MS = 900;

export interface Playback {
  /** Index of the currently-active frame, or -1 before playback starts. */
  readonly activeIndex: number;
  readonly isPlaying: boolean;
  play(): void;
}

/**
 * Steps `activeIndex` through the frames on a timer paced by each frame's
 * recorded duration (clamped so instant immediate-mode records still animate).
 */
export function usePlayback(frames: TimelineFrame[]): Playback {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Reset whenever a new timeline is supplied.
  useEffect(() => {
    clear();
    setActiveIndex(-1);
    setIsPlaying(false);
  }, [frames]);

  useEffect(() => clear, []);

  const play = useCallback((): void => {
    clear();
    if (frames.length === 0) {
      return;
    }
    setIsPlaying(true);
    setActiveIndex(0);

    const advance = (index: number): void => {
      const frame = frames[index];
      const delay = Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, frame?.durationMs ?? MIN_FRAME_MS));
      timer.current = setTimeout(() => {
        const next = index + 1;
        if (next >= frames.length) {
          setIsPlaying(false);
          return;
        }
        setActiveIndex(next);
        advance(next);
      }, delay);
    };
    advance(0);
  }, [frames]);

  return { activeIndex, isPlaying, play };
}
