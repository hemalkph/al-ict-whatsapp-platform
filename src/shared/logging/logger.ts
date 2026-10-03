type Level = "info" | "warn" | "error";

// Context carries correlation ids (request_id, organization_id, ...). Never pass secrets or message content.
export type LogContext = Record<string, string | number | boolean | null | undefined>;

function write(level: Level, message: string, context?: LogContext) {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...context });
  (level === "error" ? console.error : console.log)(line);
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
};
