import { encode } from "@toon-format/toon";

export const DESCRIPTION =
  "Agent-facing Discourse CLI over MCP; commands come from the selected forum's tools";
export const SKILL_DESCRIPTION =
  "Read and act on a Discourse forum (topics, posts, search, chat, users, moderation) through the discourse-axi CLI, whose commands are generated from the forum's MCP tools. Use whenever a task touches a Discourse forum. Do not use for other forum software.";

// One list feeds top help, per-command help and the generated skill so they cannot drift.
export const BUILTINS = [
  { command: "(none)", purpose: "Home: forum, auth state, tool count and next commands" },
  { command: "init --forum <url> [--force]", purpose: "Bind this Git worktree to a forum" },
  { command: "auth login [--manual]", purpose: "Start OAuth; the browser URL goes to stderr" },
  { command: "auth finish", purpose: "Complete a login from the callback URL on stdin" },
  { command: "auth status", purpose: "Show local auth state without credentials" },
  { command: "auth logout", purpose: "Remove this forum's local credentials" },
  { command: "tools [refresh] [--full]", purpose: "List every generated command" },
  { command: "<command> [flags]", purpose: "Call a forum tool; run `<command> --help` first" },
];

// Help is plain text in TOON's shape: prose lists would otherwise collapse onto one comma-joined line.
const lines = (label: string, items: string[]) =>
  `${label}[${items.length}]:\n${items.map((item) => `  ${item}`).join("\n")}`;

export function topHelp() {
  return [
    `description: ${DESCRIPTION}`,
    "usage: discourse-axi [command] [args] [flags]",
    encode({ commands: BUILTINS }),
    lines("flags", [
      "--forum <url>  forum base URL; accepted anywhere on the line",
      "--full  disable local truncation of long strings",
      "--help, -h  help for the top level or any command, including generated ones",
      "--version, -v  installed version",
    ]),
    "forum: --forum, then DISCOURSE_AXI_FORUM_URL, then .discourse-forum at this Git worktree's root (written only by init). No default forum.",
    lines("workflow", [
      "1. Run `discourse-axi` to see the selected forum, auth state and the next command.",
      "2. If not logged in, run `discourse-axi auth login` and give the URL it prints on stderr to the user to approve.",
      "3. If login reports login-pending, have the user pipe the complete callback URL into `discourse-axi auth finish` right after approving: the forum's authorization code expires quickly (Discourse default 300 seconds). The local pending login lasts 24 hours.",
      "4. Run `discourse-axi tools` to list commands, then `discourse-axi <command> --help` for its flags, required inputs and readOnly/destructive hints.",
      "5. Scalar inputs are flags; arrays repeat the flag once per item; nested or colliding inputs go in --json '<object>'. Input is schema-validated before anything is sent.",
    ]),
    lines("rules", [
      "Annotations are hints, not permission. Get the user's authorization before any write, reply, edit, moderation or settings change.",
      "No tool call is retried automatically. After a failed or timed-out write, inspect forum state before running it again.",
      "Never print credential files or DISCOURSE_AXI_MCP_TOKEN, and never put callback URLs, codes or tokens in arguments, logs or reports.",
    ]),
    lines("output", [
      "TOON on stdout, including errors (error, code, help). Login URLs and diagnostics go to stderr.",
      "Strings over 4000 characters end with a [truncated ...] marker; rerun with --full for the complete value.",
      "A tool isError result is a failure, never data. Follow help hints in results and errors.",
    ]),
    lines("exitCodes", [
      "0  success, including already-satisfied requests",
      "2  invalid usage or input",
      "1  failed operation, authentication, network or tool error",
    ]),
    lines("env", [
      "DISCOURSE_AXI_FORUM_URL  forum when --forum is absent",
      "DISCOURSE_AXI_MCP_URL  MCP endpoint override (default <forum>/mcp)",
      "DISCOURSE_AXI_MCP_TOKEN  bearer token that bypasses stored OAuth",
      "DISCOURSE_AXI_AUTH_FILE  credential store path",
    ]),
    lines("examples", [
      "discourse-axi init --forum https://forum.example.org",
      "discourse-axi auth login",
      "discourse-axi tools",
      "discourse-axi search --help",
      'discourse-axi search --query "release notes"',
    ]),
  ].join("\n");
}

export const BUILTIN_HELP: Record<string, string> = {
  init: [
    "usage: discourse-axi init --forum <url> [--force]",
    "description: Write .discourse-forum at this Git worktree's root so later commands select the forum without --forum. Binding the same URL again succeeds without changes.",
    lines("flags", [
      "--forum <url>  required",
      "--force  replace a binding that points to a different forum",
    ]),
  ].join("\n"),
  auth: [
    "usage: discourse-axi auth <login|finish|status|logout> [flags]",
    encode({ subcommands: BUILTINS.filter((row) => row.command.startsWith("auth ")) }),
    "help[1]: Run `discourse-axi auth <subcommand> --help` for details",
  ].join("\n"),
  "auth login": [
    "usage: discourse-axi auth login [--manual]",
    "description: Requests every scope the forum advertises; the forum grants what the account allows. Prints the authorization URL to stderr, then waits up to ten minutes for the browser callback. When the callback port cannot be bound, or with --manual, it returns login-pending at once.",
    lines("flags", ["--manual  never bind a callback port; complete with auth finish"]),
    lines("clients", [
      "codex  http://127.0.0.1/callback (tried first)",
      "claude-code  http://localhost:8080/callback (used when the forum rejects codex)",
    ]),
    lines("notes", [
      "A pending login stays valid for 24 hours; starting a new login replaces it.",
      "The forum's authorization code expires soon after approval (Discourse default 300 seconds, maximum 600), so run auth finish right after the user approves.",
    ]),
  ].join("\n"),
  "auth finish": [
    "usage: printf '%s\\n' \"$callback_url\" | discourse-axi auth finish",
    "description: Reads the complete callback URL (with code, state and iss) from stdin, verifies state and issuer, and exchanges the code. Fails at once when stdin is a terminal.",
    lines("notes", [
      "Keep the URL out of arguments and history: read -rs callback_url && printf '%s\\n' \"$callback_url\" | discourse-axi auth finish",
      "If the forum rejects the code (expired or already used), run auth login again and approve once more.",
    ]),
  ].join("\n"),
  "auth status": [
    "usage: discourse-axi auth status",
    "description: Local auth state for the selected forum: stored, expired, login-pending, not-logged-in or environment-token. Does not contact the forum.",
  ].join("\n"),
  "auth logout": [
    "usage: discourse-axi auth logout",
    "description: Removes the selected forum's stored grant and pending login. Server grants remain until revoked in the forum's user preferences; DISCOURSE_AXI_MCP_TOKEN is unaffected.",
  ].join("\n"),
  tools: [
    "usage: discourse-axi tools [refresh] [--full]",
    "description: Every tool the forum exposes to this account, with its command name and readOnly/destructive hints. Discovery is cached for 15 minutes; refresh forces it. Long descriptions are shortened unless --full is given.",
    lines("notes", [
      "Command names drop a leading discourse_ and use kebab-case. Names colliding with built-ins gain tool-; other collisions get -2, -3 in sorted tool-name order.",
    ]),
  ].join("\n"),
};

export function createSkillMarkdown() {
  return `---
name: discourse-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# discourse-axi

${DESCRIPTION}.

If \`discourse-axi\` is not installed, ask the user to install it with \`npm install -g @nikolauska/discourse-axi\` (Node.js 24 or newer).

The CLI documents itself; read its help instead of guessing:

- \`discourse-axi\` shows the selected forum, auth state, a tool summary and the next command.
- \`discourse-axi --help\` covers forum selection, login, workflow, output, exit codes and safety rules.
- \`discourse-axi <command> --help\` shows a command's flags and required inputs, including every generated forum tool.
- Follow the \`help:\` hints in responses and errors.

## Rules

- Get the user's authorization before any write; tool annotations are hints, not permission.
- Never print credential files, tokens, or OAuth callback URLs and codes.
`;
}
