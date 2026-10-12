"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `task` every `intervalMs` while the tab is visible. Rules (ADR 0015):
 *  - the next run is scheduled only AFTER the previous one finished, so runs never overlap or pile up;
 *  - a hidden tab makes NO requests (its timer only wakes at a tenth of the rate and does nothing; a visibility change to
 *    "visible" refreshes at once);
 *  - nothing runs while the browser reports it is offline;
 *  - the timer is cleared on unmount or when `enabled` turns false.
 * The task gets an AbortSignal that is aborted on cleanup, so a slow request cannot land after the user moved on.
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  enabled: boolean,
) {
  const latest = useRef(task);
  useEffect(() => {
    latest.current = task;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!controller.signal.aborted) timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      if (controller.signal.aborted || running) return;
      const visible = document.visibilityState === "visible";
      if (visible && navigator.onLine !== false) {
        running = true;
        try {
          await latest.current(controller.signal);
        } catch {
          // a failed refresh is retried on the next tick; the UI keeps showing what it has
        } finally {
          running = false;
        }
      }
      schedule(visible ? intervalMs : intervalMs * 10);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !running) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(intervalMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}
