import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formatsModule } from "ajv-formats";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { operation, usage } from "./errors.ts";

export type Flag = {
  type: "string" | "number" | "integer" | "boolean" | "json";
  array?: boolean;
  key?: string;
};
export type Flags = Record<string, Flag>;
export const globals: Flags = {
  forum: { type: "string" },
  help: { type: "boolean" },
  full: { type: "boolean" },
};
export const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export function parseFlags(args: string[], flags: Flags): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] === "-h" ? "--help" : args[i];
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
    if (!match) throw usage("Unexpected positional argument; use named flags");
    const [, name, inline] = match;
    const flag = Object.hasOwn(flags, name) ? flags[name] : undefined;
    if (!flag) throw usage(`Unknown flag --${name}`, ["Run this command with --help"]);
    if (Object.hasOwn(result, name) && !flag.array) throw usage(`Repeated flag --${name}`);
    let raw = inline;
    if (raw === undefined) {
      if (flag.type === "boolean") raw = "true";
      else {
        raw = args[++i];
        if (raw === undefined || raw.startsWith("--")) throw usage(`--${name} requires a value`);
      }
    }
    let value: unknown = raw;
    if (flag.type === "boolean") {
      if (raw !== "true" && raw !== "false") throw usage(`--${name} must be true or false`);
      value = raw === "true";
    } else if (flag.type === "number" || flag.type === "integer") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw) || !Number.isFinite(Number(raw)))
        throw usage(`--${name} must be a number`);
      value = Number(raw);
      if (flag.type === "integer" && !Number.isSafeInteger(value))
        throw usage(`--${name} must be a safe integer`);
    } else if (flag.type === "json") {
      try {
        value = JSON.parse(raw);
      } catch {
        throw usage(`--${name} must contain valid JSON`);
      }
    }
    if (flag.array) {
      const previous = result[name];
      result[name] = [...(Array.isArray(previous) ? previous : []), value];
    } else result[name] = value;
  }
  return result;
}

export function toolFlags(tool: Tool): Flags {
  const result: Flags = { ...globals, json: { type: "json" } };
  const properties = tool.inputSchema.properties ?? {};
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== "object" || !("type" in raw)) continue;
    const array = raw.type === "array";
    const schema = array && "items" in raw ? raw.items : raw;
    if (!schema || typeof schema !== "object" || !("type" in schema)) continue;
    const type = schema.type;
    if (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean")
      continue;
    const name = kebab(key);
    // Ambiguous properties remain reachable by their exact names through --json.
    if (
      !name ||
      Object.hasOwn(result, name) ||
      Object.keys(properties).filter((k) => kebab(k) === name).length > 1
    )
      continue;
    result[name] = { type, array, key };
  }
  return result;
}

export function toolArguments(tool: Tool, args: string[]) {
  const flags = toolFlags(tool);
  const parsed = parseFlags(args, flags);
  if (parsed.help) return { parsed, input: {} };
  const json = parsed.json ?? {};
  if (json === null || typeof json !== "object" || Array.isArray(json))
    throw usage("--json must be an object");
  const input: Record<string, unknown> = { ...json };
  for (const [name, value] of Object.entries(parsed)) {
    const key = flags[name].key;
    if (key === undefined) continue;
    if (Object.hasOwn(input, key)) throw usage(`Property ${key} occurs in both --json and a flag`);
    Object.defineProperty(input, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const dialect = tool.inputSchema.$schema;
  const Constructor =
    typeof dialect === "string" && dialect.includes("2020-12")
      ? Ajv2020
      : typeof dialect === "string" && dialect.includes("2019-09")
        ? Ajv2019
        : Ajv;
  const ajv = new Constructor({
    strict: false,
    allErrors: true,
    validateFormats: true,
    ownProperties: true,
  });
  // The package's CJS declaration uses export=; Node exposes the same callable as default.
  const addFormats = formatsModule as unknown as (instance: Ajv) => void;
  addFormats(ajv);
  let validate;
  try {
    validate = ajv.compile(tool.inputSchema);
  } catch {
    throw operation("The server supplied an unsupported or invalid input schema", [
      "JSON Schema draft-07, 2019-09 and 2020-12 with local references are supported",
    ]);
  }
  if (!validate(input))
    throw usage(
      "Tool arguments do not match its schema",
      (validate.errors ?? []).map(
        (e) =>
          `${e.instancePath || "/"} ${e.message ?? e.keyword}${e.keyword === "required" ? `: ${e.params.missingProperty}` : ""}`,
      ),
    );
  return { parsed, input };
}

export function extractForum(args: string[]) {
  const rest: string[] = [];
  let forum: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--forum" || arg.startsWith("--forum=")) {
      if (forum !== undefined) throw usage("Repeated flag --forum");
      forum = arg === "--forum" ? args[++i] : arg.slice(8);
      if (!forum || forum.startsWith("--")) throw usage("--forum requires a URL");
    } else rest.push(arg);
  }
  return { forum, args: rest };
}
