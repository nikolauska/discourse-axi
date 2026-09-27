import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, ListToolsResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeError, operation } from "./errors.ts";

export interface McpLike {
  listTools(cursor?: string): Promise<ListToolsResult>;
  callTool(name: string, input: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export class DiscourseMcp implements McpLike {
  private client = new Client({ name: "discourse-axi", version: "0.1.0" });
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  constructor(resource: string, token: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "error" },
      // Replaying a disconnected POST could duplicate a reply or moderation action.
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
  }
  private async connect() {
    if (!this.connected) {
      await this.client.connect(this.transport, { timeout: 30_000 });
      this.connected = true;
    }
  }
  async listTools(cursor?: string): Promise<ListToolsResult> {
    await this.connect();
    return this.client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: 30_000,
    });
  }
  async callTool(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    await this.connect();
    return this.client.callTool({ name, arguments: input }, undefined, {
      timeout: 60_000,
    }) as Promise<CallToolResult>;
  }
  async close() {
    await this.transport.close();
  }
}

export async function discover(client: McpLike): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  const names = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw operation("The MCP server repeated a tools/list cursor");
      cursors.add(cursor);
    }
    const page = await client.listTools(cursor);
    for (const tool of page.tools) {
      if (names.has(tool.name)) throw operation("The MCP server returned duplicate tool names");
      names.add(tool.name);
      tools.push(tool);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

export function isUnknownTool(error: unknown): boolean {
  return (
    error instanceof Error && /unknown tool|tool .*not found|tool not found/i.test(error.message)
  );
}

export function resultValue(result: CallToolResult): unknown {
  if (result.isError) {
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (/insufficient_scope|\b403\b/i.test(text))
      throw normalizeError(new Error("insufficient_scope"));
    if (/\b401\b|unauthorized|invalid_token/i.test(text)) throw normalizeError(new Error("401"));
    // Error bodies can echo submitted secrets. Keep them out of logs and stdout.
    throw operation("The MCP tool reported an error; it did not return success data", [
      "Check the arguments and forum permissions; inspect forum state before retrying a write",
    ]);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.content.length === 1 && result.content[0].type === "text") {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return { text: result.content[0].text };
    }
  }
  return {
    content: result.content.map((item) => {
      if (item.type !== "text") return item;
      try {
        return { type: "json", value: JSON.parse(item.text) };
      } catch {
        return item;
      }
    }),
  };
}

export function preview(value: unknown, full: boolean): unknown {
  if (full) return value;
  if (typeof value === "string")
    return value.length > 4000
      ? `${value.slice(0, 4000)}\n[truncated ${value.length - 4000} characters; use --full]`
      : value;
  if (Array.isArray(value)) return value.map((item) => preview(item, false));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, preview(item, false)]),
    );
  return value;
}
