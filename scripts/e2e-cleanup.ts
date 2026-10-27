// Runs every cleanup step even when an earlier one fails, and reports each failure (nothing is swallowed).
export async function runCleanup(
  steps: { name: string; run: () => void | Promise<void> }[],
  report: (message: string, error: unknown) => void = (m, e) => console.error(m, e),
): Promise<boolean> {
  let ok = true;
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      ok = false;
      report(`E2E cleanup step failed: ${step.name}`, error);
    }
  }
  return ok;
}
