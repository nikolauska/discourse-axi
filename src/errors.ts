import { AxiError } from "axi-sdk-js";

export { AxiError };
export const usage = (message: string, help: string[] = []) =>
  new AxiError(message, "VALIDATION_ERROR", help);
export const operation = (message: string, help: string[] = []) =>
  new AxiError(message, "OPERATION_ERROR", help);
export const loginHint = "Run `discourse-axi auth login --forum <url>`";

export function normalizeError(error: unknown): AxiError {
  if (error instanceof AxiError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  // Transport errors can contain response bodies or callback URLs; never echo them.
  if (code === 401 || /\b401\b|unauthorized|invalid_token/i.test(message)) {
    return new AxiError("MCP authentication was rejected", "NOT_AUTHENTICATED", [loginHint]);
  }
  if (code === 403 || /\b403\b|insufficient_scope/i.test(message)) {
    return new AxiError("MCP access was denied or scopes are insufficient", "FORBIDDEN", [
      "Re-run `discourse-axi auth login --forum <url>` and approve the required scopes",
    ]);
  }
  return operation("The operation failed; no tool call was automatically retried", [
    "Check the connection and forum configuration",
    "For a write, inspect the forum before retrying: it may already have completed",
  ]);
}
