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
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  constructor(resource: string, token: string, version: string) {
    this.client = new Client({ name: "discourse-axi", version });
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

export function resultValue(result: CallToolResult, command: string): Record<string, unknown> {
  if (result.isError) {
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    // Only OAuth error codes count; free text such as "post 401 not found" is an ordinary failure.
    if (/\binsufficient_scope\b/.test(text)) throw normalizeError(new Error("insufficient_scope"));
    if (/\binvalid_token\b/.test(text)) throw normalizeError(new Error("invalid_token"));
    // Error bodies can echo submitted secrets. Keep them out of logs and stdout.
    throw operation("The tool reported an error (isError); its message is withheld", [
      `Check the inputs with \`discourse-axi ${command} --help\` and the account's forum permissions`,
      "A write may already have partly completed: inspect forum state before running it again",
    ]);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  // An explicit marker keeps "no output" from looking like a missing or broken response.
  if (result.content.length === 0) return { result: "The tool succeeded and returned no content" };
  if (result.content.length === 1 && result.content[0].type === "text") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content[0].text);
    } catch {
      return { text: result.content[0].text };
    }
    // Scalars and arrays are wrapped so every result renders as one TOON document.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
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

export function preview<T>(value: T, full: boolean): T {
  if (full) return value;
  return truncate(value) as T;
}

function truncate(value: unknown): unknown {
  if (typeof value === "string")
    return value.length > 4000
      ? `${value.slice(0, 4000)}\n[truncated ${value.length - 4000} more characters; rerun with --full]`
      : value;
  if (Array.isArray(value)) return value.map(truncate);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncate(item)]));
  return value;
}
