// "Latest started request wins" for one kind of refresh (the list, or the open conversation).
//
// Polling, manual reloads, refreshes after a change, selecting another conversation and changing a filter all fetch the same
// state. Responses can arrive in any order, so a response may only be applied if no newer request of its lane has started since.
// Starting a request also aborts the previous one, which saves the work; the generation check is what guarantees correctness
// (a response can still win the race against its own abort).

export type LaneRequest = {
  /** Pass to fetch: aborted when a newer request starts, when the lane is cancelled, or when `external` aborts. */
  readonly signal: AbortSignal;
  /** False once any newer request has started or the lane was cancelled: the response must be dropped. */
  isCurrent: () => boolean;
};

export type Lane = {
  begin: (external?: AbortSignal) => LaneRequest;
  /** Supersedes whatever is running without starting anything (selection changed, unmount). */
  cancel: () => void;
};

export function createLane(): Lane {
  let generation = 0;
  let running: AbortController | null = null;
  return {
    begin(external) {
      running?.abort();
      const mine = ++generation;
      const own = new AbortController();
      running = own;
      return {
        signal: external ? AbortSignal.any([external, own.signal]) : own.signal,
        isCurrent: () => mine === generation,
      };
    },
    cancel() {
      running?.abort();
      running = null;
      generation++;
    },
  };
}
