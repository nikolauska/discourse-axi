import { createRequire } from "node:module";
import { encode } from "@toon-format/toon";
import { extractForum, globals, parseFlags, toolArguments } from "./args.ts";
import { OAuth, callbackListener } from "./auth.ts";
import { Catalog, commands, toolHelp, toolRows } from "./catalog.ts";
import { bindForum, resolveForum, statePaths } from "./config.ts";
import { normalizeError, usage } from "./errors.ts";
import { DiscourseMcp, isUnknownTool, preview, resultValue } from "./mcp.ts";
import type { McpLike } from "./mcp.ts";
import { BUILTINS, topHelp } from "./skill.ts";
import { TokenStore } from "./store.ts";

const { version } = createRequire(import.meta.url)("../package.json");
export interface Context {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  readInput: () => Promise<string>;
  client?: McpLike;
  fetch?: typeof fetch;
}

async function login(auth: OAuth, manual: boolean, context: Context) {
  let started = await auth.begin();
  while (true) {
    let listener;
    if (!manual) {
      try {
        listener = await callbackListener(started.pending.redirect);
      } catch (error) {
        const reason =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "listener unavailable";
        context.stderr.write(
          `Cannot bind ${started.pending.redirect} (${reason}). Use manual completion.\n`,
        );
      }
    }
    context.stderr.write(
      `Open this URL and approve the requested access:\n${started.authorizationUrl}\n`,
    );
    if (!listener)
      return {
        status: "login-pending",
        clientId: started.pending.clientId,
        redirect: started.pending.redirect,
        help: [
          "Feed the complete callback URL to `discourse-axi auth finish --forum <url>` on stdin; do not put it in shell history",
        ],
      };
    try {
      const result = await auth.finish(await listener.callback);
      if (result.status === "authenticated") return result;
      started = result;
    } finally {
      listener.close();
    }
  }
}

export async function main(argv: string[], context: Context): Promise<number> {
  let client: McpLike | undefined;
  try {
    const extracted = extractForum(argv);
    const [command, ...args] = extracted.args;
    let value: unknown;
    if (command === "--help" || command === "-h" || command === "help") {
      parseFlags(args, { help: globals.help });
      value = topHelp();
    } else if (command === "--version" || command === "version") {
      parseFlags(args, {});
      value = { version };
    } else if (
      ["auth", "init", "tools"].includes(command) &&
      args.some((a) => a === "--help" || a === "-h")
    ) {
      const subcommand = args[0]?.startsWith("-") ? undefined : args[0];
      if (
        subcommand &&
        !(
          command === "auth"
            ? ["login", "finish", "status", "logout"]
            : command === "tools"
              ? ["refresh"]
              : []
        ).includes(subcommand)
      )
        throw usage("Unknown built-in subcommand");
      parseFlags(subcommand ? args.slice(1) : args, {
        help: globals.help,
        ...(command === "auth" && subcommand === "login" ? { manual: globals.help } : {}),
        ...(command === "init" ? { force: globals.help } : {}),
        ...(command === "tools" ? { full: globals.full } : {}),
      });
      value = {
        commands: BUILTINS.filter((row) => row.command.startsWith(command)),
        forum: "--forum <url>",
        manualCompletion:
          "auth finish reads the complete callback URL from stdin; never put codes in arguments",
      };
    } else {
      const selected = await resolveForum(extracted.forum, context.env, context.cwd);
      const paths = statePaths(context.env);
      const store = new TokenStore(paths.auth);
      const auth = new OAuth(selected.resource, store, context.env, context.fetch);
      if (command === "init") {
        const flags = parseFlags(args, { force: { type: "boolean" } });
        if (!extracted.forum) throw usage("init requires an explicit --forum <url>");
        value = await bindForum(context.cwd, selected.forum, flags.force === true);
      } else if (command === "auth") {
        const [action, ...rest] = args;
        const flags = parseFlags(rest, action === "login" ? { manual: { type: "boolean" } } : {});
        if (action === "login") value = await login(auth, flags.manual === true, context);
        else if (action === "finish") {
          const result = await auth.finish(await context.readInput());
          if (result.status === "pending") {
            context.stderr.write(
              `Primary client rejected; open the fallback URL:\n${result.authorizationUrl}\n`,
            );
            value = {
              status: "login-pending",
              clientId: result.pending.clientId,
              help: [
                "Approve access and run auth finish again with the complete callback URL on stdin",
              ],
            };
          } else value = result;
        } else if (action === "status") value = { ...selected, ...(await auth.status()) };
        else if (action === "logout") {
          await store.update(selected.resource, () => undefined);
          value = {
            status: "logged-out",
            ...selected,
            note: "Only local credentials were removed. Revoke the grant in forum preferences if needed.",
            ...(context.env.DISCOURSE_AXI_MCP_TOKEN
              ? {
                  warning:
                    "DISCOURSE_AXI_MCP_TOKEN still supplies authentication; unset it to stop using it",
                }
              : {}),
          };
        } else throw usage("Expected auth login, finish, status or logout");
      } else {
        const status = await auth.status();
        if (!command && ["not-logged-in", "login-pending"].includes(status.status)) {
          value = {
            ...selected,
            auth: status,
            tools: "Login is required before discovery",
            help: ["Run `discourse-axi auth login --forum <url>`"],
          };
        } else {
          const credentials = await auth.credentials();
          client = context.client ?? new DiscourseMcp(selected.resource, credentials.token);
          const catalog = new Catalog(
            paths.cache,
            selected.forum,
            selected.resource,
            credentials.token,
            credentials.scopes,
          );
          if (command === "tools") {
            const refresh = args[0] === "refresh";
            const flags = parseFlags(refresh ? args.slice(1) : args, { full: globals.full });
            const tools = await catalog.load(client, refresh);
            value = preview(
              { ...selected, count: tools.length, tools: toolRows(tools) },
              flags.full === true,
            );
          } else if (!command) {
            const tools = await catalog.load(client);
            value = {
              ...selected,
              auth: status,
              toolCount: tools.length,
              tools: toolRows(tools)
                .slice(0, 8)
                .map((row) => ({
                  command: row.command,
                  readOnly: row.readOnly,
                  destructive: row.destructive,
                })),
              help: [
                "Run `discourse-axi tools` for all commands",
                "Run `discourse-axi <command> --help` before calling a tool",
              ],
            };
          } else {
            let tools = await catalog.load(client);
            let tool = commands(tools).get(command);
            if (!tool) {
              tools = await catalog.load(client, true);
              tool = commands(tools).get(command);
            }
            if (!tool)
              throw usage("Unknown command for this forum", [
                "Run `discourse-axi tools` to list commands",
              ]);
            const parsed = toolArguments(tool, args);
            if (parsed.parsed.help) value = toolHelp(command, tool);
            else {
              try {
                const result = await client.callTool(tool.name, parsed.input);
                if (
                  result.isError &&
                  result.content.some(
                    (item) =>
                      item.type === "text" &&
                      /unknown tool|tool .*not found|tool not found/i.test(item.text),
                  )
                )
                  await catalog.load(client, true);
                value = preview(resultValue(result), parsed.parsed.full === true);
              } catch (error) {
                if (isUnknownTool(error)) await catalog.load(client, true);
                // Refresh discovery, but never replay the user's operation under a new schema.
                throw error;
              }
            }
          }
        }
      }
    }
    context.stdout.write(`${encode(value)}\n`);
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    context.stdout.write(
      `${encode({ error: normalized.message, code: normalized.code, help: normalized.suggestions })}\n`,
    );
    return normalized.code === "VALIDATION_ERROR" ? 2 : 1;
  } finally {
    await client?.close().catch(() => undefined);
  }
}
