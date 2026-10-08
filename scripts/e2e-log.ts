// What the application server may print during an E2E run. Used by scripts/e2e.ts, whose job is to fail the run when the
// server logged anything that looks like a real error. This is deliberately NOT narrowed for any particular error:
// `Error: aborted` / ECONNRESET and uncaught exceptions are failures like any other (see docs/TESTING_STRATEGY.md).

// Expected 4xx responses are not logged by the application, so any match is a problem.
export const SERVER_ERROR_PATTERN =
  /unhandled|uncaught|TypeError|ReferenceError|RangeError|\u2a2f|\bERROR\b|57P01|ECONNRESET/i;

/** Indexes of the server log lines that make a run fail. */
export function flaggedServerLines(serverLines: readonly string[]): number[] {
  return serverLines.flatMap((line, index) => (SERVER_ERROR_PATTERN.test(line) ? [index] : []));
}
