import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowFrame } from "./flow-model.js";

const MIN_FRAME_MS = 250;
const MAX_FRAME_MS = 900;

export interface FlowPlayback {
  /** Index of the active frame, or -1 before playback starts. */
  readonly activeIndex: number;
  readonly isPlaying: boolean;
  readonly frameCount: number;
  /** Resume from the current position (or restart from 0 if idle/at the end). */
  play(): void;
  pause(): void;
  toggle(): void;
  stepForward(): void;
  stepBack(): void;
  /** Jump to a specific index and pause (used by the scrubber and stage clicks). */
  seek(index: number): void;
  restart(): void;
}

/**
 * Drives `activeIndex` through the flow frames. Auto-play advances on a timer
 * paced by each frame's duration; manual controls (step/seek/pause) let the
 * user freeze the timeline to inspect a stage.
 */
export function useFlowPlayback(frames: readonly FlowFrame[]): FlowPlayback {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const framesRef = useRef(frames);
  framesRef.current = frames;

  const clearTimer = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Reset whenever a new set of frames arrives.
  useEffect(() => {
    clearTimer();
    setActiveIndex(-1);
    setIsPlaying(false);
  }, [frames, clearTimer]);

  // Clear any pending timer on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  const runFrom = useCallback((startIndex: number): void => {
    clearTimer();
    const all = framesRef.current;
    if (all.length === 0) {
      return;
    }
    const begin = startIndex >= all.length - 1 ? 0 : Math.max(0, startIndex);
    setIsPlaying(true);
    setActiveIndex(begin);

    const advance = (index: number): void => {
      const frame = all[index];
      const delay = Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, frame?.durationMs ?? MIN_FRAME_MS));
      timer.current = setTimeout(() => {
        const next = index + 1;
        if (next >= all.length) {
          setIsPlaying(false);
          return;
        }
        setActiveIndex(next);
        advance(next);
      }, delay);
    };
    advance(begin);
  }, [clearTimer]);

  const play = useCallback((): void => {
    runFrom(activeIndex);
  }, [runFrom, activeIndex]);

  const pause = useCallback((): void => {
    clearTimer();
    setIsPlaying(false);
  }, [clearTimer]);

  const toggle = useCallback((): void => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, pause, play]);

  const seek = useCallback((index: number): void => {
    clearTimer();
    setIsPlaying(false);
    const max = framesRef.current.length - 1;
    setActiveIndex(Math.max(-1, Math.min(max, index)));
  }, [clearTimer]);

  const stepForward = useCallback((): void => {
    clearTimer();
    setIsPlaying(false);
    setActiveIndex((current) => Math.min(framesRef.current.length - 1, current + 1));
  }, [clearTimer]);

  const stepBack = useCallback((): void => {
    clearTimer();
    setIsPlaying(false);
    setActiveIndex((current) => Math.max(0, current - 1));
  }, [clearTimer]);

  const restart = useCallback((): void => {
    runFrom(0);
  }, [runFrom]);

  return {
    activeIndex,
    isPlaying,
    frameCount: frames.length,
    play,
    pause,
    toggle,
    stepForward,
    stepBack,
    seek,
    restart,
  };
}
