import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { kebab, toolFlags } from "./args.ts";
import { discover } from "./mcp.ts";
import type { McpLike } from "./mcp.ts";

const builtins: Record<string, true> = {
  auth: true,
  init: true,
  tools: true,
  help: true,
  version: true,
};
const Cached = z.object({ savedAt: z.number(), tools: z.array(ToolSchema) });

export function commands(tools: Tool[]) {
  const result = new Map<string, Tool>();
  // Sorting makes collision resolution independent of server pagination order.
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    let name = kebab(tool.name.replace(/^discourse_/, "")) || "tool";
    if (Object.hasOwn(builtins, name)) name = `tool-${name}`;
    const base = name;
    let suffix = 2;
    while (result.has(name) || Object.hasOwn(builtins, name)) name = `${base}-${suffix++}`;
    result.set(name, tool);
  }
  return result;
}

export class Catalog {
  private path: string;
  readonly directory: string;
  constructor(
    directory: string,
    forum: string,
    resource: string,
    token: string,
    scopes?: string[],
  ) {
    this.directory = directory;
    // Token fingerprint isolates accounts and direct tokens whose scopes cannot be introspected.
    const identity = createHash("sha256").update(token).digest("hex");
    const key = createHash("sha256")
      .update(JSON.stringify([forum, resource, [...(scopes ?? [])].sort(), identity]))
      .digest("hex");
    this.path = join(directory, `${key}.json`);
  }
  async load(client: McpLike, refresh = false): Promise<Tool[]> {
    if (!refresh) {
      try {
        const cached = Cached.parse(JSON.parse(await readFile(this.path, "utf8")));
        if (cached.savedAt > Date.now() - 15 * 60_000 && cached.savedAt <= Date.now())
          return cached.tools;
      } catch {
        /* A disposable cache must never prevent fresh discovery. */
      }
    }
    const tools = await discover(client);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), tools }), { mode: 0o600 });
    await rename(temporary, this.path);
    return tools;
  }
}

export function toolHelp(name: string, tool: Tool) {
  const flags = toolFlags(tool);
  return {
    usage: `discourse-axi ${name} [flags] --forum <url>`,
    tool: tool.name,
    description: tool.description ?? "",
    annotations: tool.annotations ?? {},
    flags: Object.entries(flags).map(([flag, value]) => ({
      flag: `--${flag}`,
      type: value.type,
      repeatable: Boolean(value.array),
      required: value.key ? (tool.inputSchema.required ?? []).includes(value.key) : false,
      ...(value.key
        ? { property: value.key, schema: tool.inputSchema.properties?.[value.key] }
        : {}),
    })),
    inputSchema: tool.inputSchema,
    help: [
      "--json '<object>' accepts nested objects, unions, exact property names and flags that collide with built-ins",
      "Do not repeat a property in both --json and a flag",
      "Boolean flags accept --flag or --flag=false; array flags repeat once per item",
      "--full disables local text truncation",
    ],
  };
}

export function toolRows(tools: Tool[]) {
  return [...commands(tools)].map(([command, tool]) => ({
    command,
    tool: tool.name,
    description: tool.description ?? "",
    readOnly: tool.annotations?.readOnlyHint ?? "unspecified",
    destructive: tool.annotations?.destructiveHint ?? "unspecified",
  }));
}
