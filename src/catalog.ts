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

// update is axi-sdk-js's self-update command; a forum tool must never shadow it.
export const builtins: Record<string, true> = {
  auth: true,
  init: true,
  tools: true,
  help: true,
  update: true,
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

const constraintKeys = [
  "enum",
  "const",
  "default",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
] as const;

function constraints(schema: unknown) {
  const result: Record<string, unknown> = {};
  if (!schema || typeof schema !== "object") return result;
  for (const key of constraintKeys)
    if (Object.hasOwn(schema, key)) result[key] = (schema as Record<string, unknown>)[key];
  return result;
}

export function toolHelp(name: string, tool: Tool, full: boolean) {
  const flags = toolFlags(tool);
  const properties = tool.inputSchema.properties ?? {};
  const required = tool.inputSchema.required ?? [];
  const flagged = new Set(Object.values(flags).flatMap((flag) => (flag.key ? [flag.key] : [])));
  const jsonOnly = Object.keys(properties).filter((key) => !flagged.has(key));
  // Top-level composition can require inputs no single property flag expresses.
  const composed = [
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "dependentRequired",
    "dependentSchemas",
  ].filter((key) => Object.hasOwn(tool.inputSchema, key));
  return {
    command: name,
    tool: tool.name,
    usage: `discourse-axi ${name} ${Object.entries(flags)
      .filter(([, flag]) => flag.key && required.includes(flag.key))
      .map(([flag]) => `--${flag} <value>`)
      .concat("[flags]")
      .join(" ")}`,
    description: tool.description ?? "",
    annotations: tool.annotations ?? "none",
    flags: Object.entries(flags)
      .filter(([, flag]) => flag.key)
      .map(([flag, value]) => {
        const schema = properties[value.key!] as Record<string, unknown> | undefined;
        const items = value.array ? schema?.items : undefined;
        return {
          flag: `--${flag}`,
          type: value.array ? `${value.type}[] (repeat per item)` : value.type,
          required: required.includes(value.key!),
          ...(typeof schema?.description === "string" ? { description: schema.description } : {}),
          ...constraints(schema),
          ...(items && Object.keys(constraints(items)).length > 0
            ? { items: constraints(items) }
            : {}),
        };
      }),
    ...(jsonOnly.length > 0
      ? {
          jsonOnly: jsonOnly.map((key) => ({
            property: key,
            required: required.includes(key),
            schema: properties[key],
          })),
        }
      : {}),
    ...(composed.length > 0 ? { schemaRules: composed.join(", ") } : {}),
    ...(full ? { inputSchema: tool.inputSchema } : {}),
    commonFlags: {
      "--json '<object>'": "inputs by exact property name; the only way to pass jsonOnly inputs",
      "--full": "no local truncation of results",
      "--forum <url>": "forum to call",
    },
    help: [
      ...(full
        ? []
        : [`Run \`discourse-axi ${name} --help --full\` for the complete input schema`]),
      ...(tool.annotations?.readOnlyHint === true
        ? []
        : ["Not marked read-only: get the user's authorization before running it"]),
    ],
  };
}

const DESCRIPTION_PREVIEW = 160;

export function toolRows(tools: Tool[], full: boolean) {
  return [...commands(tools)].map(([command, tool]) => {
    const description = tool.description ?? "";
    const firstLine = description.split("\n", 1)[0];
    const short =
      firstLine.length > DESCRIPTION_PREVIEW ? firstLine.slice(0, DESCRIPTION_PREVIEW) : firstLine;
    return {
      command,
      tool: tool.name,
      description: full || short === description ? description : `${short.trimEnd()} …[truncated]`,
      readOnly: tool.annotations?.readOnlyHint ?? "unspecified",
      destructive: tool.annotations?.destructiveHint ?? "unspecified",
    };
  });
}
