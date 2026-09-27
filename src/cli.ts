import { createRequire } from "node:module";
import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import type { AxiCliCommand } from "axi-sdk-js";
import { extractForum, globals, parseFlags, toolArguments } from "./args.ts";
import type { Flags } from "./args.ts";
import { OAuth, callbackListener } from "./auth.ts";
import { Catalog, builtins, commands, toolHelp, toolRows } from "./catalog.ts";
import { bindForum, findForum, resolveForum, statePaths } from "./config.ts";
import { AxiError, loginHint, normalizeError, operation, usage } from "./errors.ts";
import { DiscourseMcp, isUnknownTool, preview, resultValue } from "./mcp.ts";
import type { McpLike } from "./mcp.ts";
import { BUILTIN_HELP, DESCRIPTION, topHelp } from "./skill.ts";
import { TokenStore } from "./store.ts";

const { version } = createRequire(import.meta.url)("../package.json");
const HOME_TOOLS = 8;
const finishHint =
  "After the user approves, pipe the complete callback URL into `discourse-axi auth finish --forum <url>` right away";

export interface Context {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  readInput: () => Promise<string>;
  client?: McpLike;
  fetch?: typeof fetch;
}

/** Per-invocation state shared by command handlers and the error boundary. */
class Runtime {
  readonly context: Context;
  readonly forumFlag: string | undefined;
  selected?: { forum: string; resource: string };
  client?: McpLike;
  // Set just before tools/call so failures after it carry the inspect-before-retry warning.
  toolCalled = false;
  constructor(context: Context, forumFlag: string | undefined) {
    this.context = context;
    this.forumFlag = forumFlag;
  }

  async forum() {
    this.selected ??= await resolveForum(this.forumFlag, this.context.env, this.context.cwd);
    return this.selected;
  }

  async oauth() {
    const { resource } = await this.forum();
    const store = new TokenStore(statePaths(this.context.env).auth);
    return { store, auth: new OAuth(resource, store, this.context.env, this.context.fetch) };
  }

  async connect(auth: OAuth) {
    const selected = await this.forum();
    const credentials = await auth.credentials();
    this.client =
      this.context.client ?? new DiscourseMcp(selected.resource, credentials.token, version);
    const catalog = new Catalog(
      statePaths(this.context.env).cache,
      selected.forum,
      selected.resource,
      credentials.token,
      credentials.scopes,
    );
    return { client: this.client, catalog };
  }

  /**
   * Suggested commands must work when pasted: an explicit --forum is carried forward, a
   * forum found through the environment or binding needs no flag, and only an unresolved
   * forum keeps the placeholder.
   */
  scope(text: string) {
    if (this.forumFlag) return text.replaceAll("--forum <url>", `--forum ${this.forumFlag}`);
    return this.selected ? text.replaceAll(" --forum <url>", "") : text;
  }
}

const isHelp = (arg: string) => arg === "--help" || arg === "-h";

/** Returns built-in help after validating flags, so a mistyped flag still fails with --help. */
function helpFor(name: string, args: string[], flags: Flags) {
  if (!args.some(isHelp)) return undefined;
  parseFlags(args, { ...flags, help: globals.help });
  return BUILTIN_HELP[name];
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
        status: "login-pending" as const,
        clientId: started.pending.clientId,
        redirect: started.pending.redirect,
        pendingExpiresAt: new Date(started.pending.expiresAt).toISOString(),
        help: [finishHint, "Keep the callback URL out of arguments and shell history"],
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

async function home(rt: Runtime) {
  const { env, cwd } = rt.context;
  rt.selected = await findForum(rt.forumFlag, env, cwd);
  if (!rt.selected)
    return {
      forum: "none selected",
      help: [
        "Run `discourse-axi init --forum <url>` to bind this Git worktree to a forum",
        "Or pass --forum <url> or set DISCOURSE_AXI_FORUM_URL",
        "Run `discourse-axi --help` for usage",
      ],
    };
  const { auth } = await rt.oauth();
  const status = await auth.status();
  if (status.status === "not-logged-in" || status.status === "login-pending")
    return {
      forum: rt.selected.forum,
      auth: status.status,
      help: status.status === "login-pending" ? [finishHint, loginHint] : [loginHint],
    };
  const { client, catalog } = await rt.connect(auth);
  const tools = await catalog.load(client);
  const rows = toolRows(tools, false);
  return {
    forum: rt.selected.forum,
    auth: status.status,
    toolCount: tools.length,
    tools:
      rows.length === 0
        ? "none enabled for this account"
        : rows.slice(0, HOME_TOOLS).map(({ command, readOnly, destructive }) => ({
            command,
            readOnly,
            destructive,
          })),
    help: [
      ...(rows.length > HOME_TOOLS
        ? [`Run \`discourse-axi tools --forum <url>\` to see all ${rows.length} commands`]
        : []),
      "Run `discourse-axi <command> --help --forum <url>` before calling a tool",
    ],
  };
}

const init: AxiCliCommand<Runtime> = async (args, rt) => {
  const help = helpFor("init", args, { force: globals.help });
  if (help) return help;
  const flags = parseFlags(args, { force: { type: "boolean" } });
  if (!rt!.forumFlag)
    throw usage("init requires an explicit --forum <url>", [
      "Run `discourse-axi init --forum <url>`",
    ]);
  const { forum } = await rt!.forum();
  return {
    ...(await bindForum(rt!.context.cwd, forum, flags.force === true)),
    help: ["Run `discourse-axi` to check auth state and available tools"],
  };
};

const authFlags: Record<string, Flags> = {
  login: { manual: { type: "boolean" } },
  finish: {},
  status: {},
  logout: {},
};

const authCommand: AxiCliCommand<Runtime> = async (args, rt) => {
  const [action, ...rest] = args;
  if (action !== undefined && isHelp(action)) {
    parseFlags(args, { help: globals.help });
    return BUILTIN_HELP.auth;
  }
  if (action === undefined || !Object.hasOwn(authFlags, action))
    throw usage("Expected auth login, finish, status or logout", [
      "Run `discourse-axi auth --help`",
    ]);
  const help = helpFor(`auth ${action}`, rest, authFlags[action]);
  if (help) return help;
  const flags = parseFlags(rest, authFlags[action]);
  const selected = await rt!.forum();
  const { auth, store } = await rt!.oauth();
  const { context } = rt!;
  if (action === "login" || action === "finish") {
    const result =
      action === "login"
        ? await login(auth, flags.manual === true, context)
        : await auth.finish(await context.readInput());
    if (result.status === "pending") {
      context.stderr.write(
        `The codex client was rejected; open the claude-code fallback URL:\n${result.authorizationUrl}\n`,
      );
      return {
        status: "login-pending",
        clientId: result.pending.clientId,
        redirect: result.pending.redirect,
        help: [finishHint],
      };
    }
    if (result.status === "authenticated")
      return { ...result, help: ["Run `discourse-axi tools --forum <url>` to list commands"] };
    return result;
  }
  if (action === "status") {
    const status = await auth.status();
    return {
      forum: selected.forum,
      resource: selected.resource,
      ...status,
      ...(status.status === "not-logged-in" || status.status === "expired"
        ? { help: [loginHint] }
        : status.status === "login-pending"
          ? { help: [finishHint] }
          : {}),
    };
  }
  const existing = await store.get(selected.resource);
  await store.update(selected.resource, () => undefined);
  return {
    status: "logged-out",
    forum: selected.forum,
    removedLocalCredentials: Boolean(existing.grant || existing.pending),
    note: "Server grants remain until revoked in the forum's user preferences",
    ...(context.env.DISCOURSE_AXI_MCP_TOKEN
      ? {
          warning:
            "DISCOURSE_AXI_MCP_TOKEN still supplies authentication; unset it to stop using it",
        }
      : {}),
  };
};

const toolsCommand: AxiCliCommand<Runtime> = async (args, rt) => {
  const refresh = args[0] === "refresh";
  const rest = refresh ? args.slice(1) : args;
  const help = helpFor("tools", rest, { full: globals.full });
  if (help) return help;
  const flags = parseFlags(rest, { full: globals.full });
  const full = flags.full === true;
  const { forum } = await rt!.forum();
  const { auth } = await rt!.oauth();
  const { client, catalog } = await rt!.connect(auth);
  const tools = await catalog.load(client, refresh);
  if (tools.length === 0)
    return {
      forum,
      count: 0,
      tools: "none enabled for this account",
      help: ["Ask a forum admin to enable MCP tools, then run `discourse-axi tools refresh`"],
    };
  const rows = toolRows(tools, full);
  return preview(
    {
      forum,
      count: tools.length,
      tools: rows,
      help: [
        "Run `discourse-axi <command> --help --forum <url>` for a command's flags",
        ...(!full && rows.some((row) => row.description.endsWith("…[truncated]"))
          ? ["Descriptions are shortened; add --full or run `<command> --help` for full text"]
          : []),
      ],
    },
    full,
  );
};

function generated(command: string): AxiCliCommand<Runtime> {
  return async (args, rt) => {
    const { auth } = await rt!.oauth();
    const { client, catalog } = await rt!.connect(auth);
    let tool = commands(await catalog.load(client)).get(command);
    // A cached catalog can predate a newly enabled tool.
    tool ??= commands(await catalog.load(client, true)).get(command);
    if (!tool)
      throw usage(`Unknown command: ${command}`, [
        "Run `discourse-axi tools --forum <url>` to list this forum's commands",
        "Run `discourse-axi --help` for built-in commands",
      ]);
    const parsed = toolArguments(tool, args);
    if (parsed.parsed.help) return toolHelp(command, tool, parsed.parsed.full === true);
    rt!.toolCalled = true;
    try {
      const result = await client.callTool(tool.name, parsed.input);
      if (
        result.isError &&
        result.content.some(
          (item) =>
            item.type === "text" && /unknown tool|tool .*not found|tool not found/i.test(item.text),
        )
      )
        await catalog.load(client, true);
      return preview(resultValue(result, command), parsed.parsed.full === true);
    } catch (error) {
      if (!isUnknownTool(error)) throw error;
      // Refresh discovery, but never replay the user's operation under a new schema.
      await catalog.load(client, true);
      throw operation("The forum no longer offers this tool; the command list was refreshed", [
        "Run `discourse-axi tools --forum <url>` to see current commands",
      ]);
    }
  };
}

/** Translates every failure and scopes its hints before axi-sdk-js renders it. */
function boundary(handler: AxiCliCommand<Runtime>): AxiCliCommand<Runtime> {
  return async (args, rt) => {
    try {
      const output = await handler(args, rt);
      if (output && typeof output === "object" && "help" in output && Array.isArray(output.help))
        return { ...output, help: output.help.map((line: string) => rt!.scope(line)) };
      return output;
    } catch (error) {
      const normalized = normalizeError(error, rt!.toolCalled);
      throw new AxiError(
        normalized.message,
        normalized.code,
        normalized.suggestions.map((line) => rt!.scope(line)),
      );
    }
  };
}

export async function main(argv: string[], context: Context): Promise<number> {
  // runAxiCli reports through process.exitCode; isolate it so embedders and tests get a return value.
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let runtime: Runtime | undefined;
  try {
    let extracted;
    try {
      extracted = extractForum(argv);
    } catch (error) {
      const { message, code, suggestions } = normalizeError(error);
      context.stdout.write(
        `${encode({ error: message, code, ...(suggestions.length ? { help: suggestions } : {}) })}\n`,
      );
      return 2;
    }
    const args =
      extracted.args.length === 1 && extracted.args[0] === "-h" ? ["--help"] : extracted.args;
    const [command] = args;
    const handlers: Record<string, AxiCliCommand<Runtime>> = {
      init: boundary(init),
      auth: boundary(authCommand),
      tools: boundary(toolsCommand),
      help: boundary(async (rest) => {
        parseFlags(rest, {});
        return topHelp();
      }),
    };
    // Generated commands are only known after discovery, so the invoked name is routed
    // lazily instead of listing the catalog before dispatch.
    if (command && !command.startsWith("-") && !Object.hasOwn(builtins, command))
      handlers[command] = boundary(generated(command));
    await runAxiCli<Runtime>({
      argv: args,
      description: DESCRIPTION,
      version,
      stdout: context.stdout,
      topLevelHelp: topHelp(),
      home: boundary(async (_args, rt) => home(rt!)),
      commands: handlers,
      resolveContext: () => (runtime = new Runtime(context, extracted.forum)),
    });
    return Number(process.exitCode ?? 0);
  } finally {
    await runtime?.client?.close().catch(() => undefined);
    process.exitCode = previousExitCode;
  }
}
