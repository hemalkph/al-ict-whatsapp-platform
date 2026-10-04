// Waits until the application server has finished handling every request it has received (harness-only endpoint in
// e2e/server.mjs). A browser that closes a page, or navigates away, while the server is still working on a request
// cancels it; Node then aborts the request and Next logs `Error: aborted` (ECONNRESET). Letting the server finish first
// removes that race by ordering. It does not hide anything: if requests never drain, this throws and the test fails.

const POLL_MS = 25;

export async function serverIdle(timeoutMs = 10_000): Promise<void> {
  const port = process.env.E2E_CONTROL_PORT;
  if (!port) throw new Error("E2E_CONTROL_PORT is not set. Run with `npm run test:e2e`.");
  const deadline = Date.now() + timeoutMs;
  let quiet = 0; // consecutive polls that saw nothing in flight
  for (;;) {
    const response = await fetch(`http://127.0.0.1:${port}/in-flight`);
    const { inFlight } = (await response.json()) as { inFlight: number };
    quiet = inFlight === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return;
    if (Date.now() > deadline) {
      throw new Error(
        `The application server still has ${inFlight} request(s) in flight after ${timeoutMs} ms.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
