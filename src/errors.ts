import { AxiError } from "axi-sdk-js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export { AxiError };
export const usage = (message: string, help: string[] = []) =>
  new AxiError(message, "VALIDATION_ERROR", help);
export const operation = (message: string, help: string[] = []) =>
  new AxiError(message, "OPERATION_ERROR", help);
// `--forum <url>` is rewritten by the CLI to the caller's actual forum scope.
export const loginHint = "Run `discourse-axi auth login --forum <url>`";
const inspectFirst =
  "A write may already have completed: inspect forum state before running it again";

const networkCodes: Record<string, true> = {
  ECONNREFUSED: true,
  ECONNRESET: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  ETIMEDOUT: true,
  EHOSTUNREACH: true,
  UND_ERR_SOCKET: true,
  UND_ERR_CONNECT_TIMEOUT: true,
};

function networkFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== "object") return false;
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && Object.hasOwn(networkCodes, code)) return true;
    if (current instanceof TypeError && current.message === "fetch failed") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/**
 * `toolCalled` separates failures that may have changed forum state from ones
 * that happened before any tool ran, because only the former need the
 * inspect-before-retry warning.
 */
export function normalizeError(error: unknown, toolCalled = false): AxiError {
  if (error instanceof AxiError) return error;
  // Transport errors can contain response bodies or callback URLs; never echo their text.
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout)
      return operation(
        toolCalled ? "The tool call timed out and was not retried" : "The MCP request timed out",
        [toolCalled ? inspectFirst : "Run the command again when the forum responds"],
      );
    if (error.code === ErrorCode.InvalidParams)
      return usage("The MCP server rejected the request parameters", [
        "Run `discourse-axi <command> --help` and check the inputs",
      ]);
    return operation(
      toolCalled ? "The tool call failed and was not retried" : "The MCP server returned an error",
      toolCalled ? [inspectFirst] : ["Run `discourse-axi tools refresh`, then try again"],
    );
  }
  const status = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  // Only HTTP statuses and OAuth error codes count: tool text such as "post 401" must not.
  if (status === 401 || /\binvalid_token\b/.test(message))
    return new AxiError("MCP authentication was rejected", "NOT_AUTHENTICATED", [loginHint]);
  if (status === 403 || /\binsufficient_scope\b/.test(message))
    return new AxiError("MCP access was denied or scopes are insufficient", "FORBIDDEN", [
      "Run `discourse-axi auth login --forum <url>` and approve the requested scopes",
    ]);
  if (networkFailure(error))
    return operation(
      toolCalled
        ? "The connection failed during the tool call; it was not retried"
        : "Cannot reach the forum's MCP endpoint",
      [toolCalled ? inspectFirst : "Check the forum URL, DISCOURSE_AXI_MCP_URL and the network"],
    );
  return operation(
    toolCalled ? "The tool call failed and was not retried" : "The operation failed",
    [toolCalled ? inspectFirst : "Run the command again; if it keeps failing, check the forum"],
  );
}
