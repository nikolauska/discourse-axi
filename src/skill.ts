export const DESCRIPTION =
  "Agent-facing Discourse CLI over MCP; commands come from the selected forum";
export const BUILTINS = [
  {
    command: "init --forum <url> [--force]",
    purpose: "Bind this Git worktree to a forum (writes .discourse-forum)",
  },
  {
    command: "auth login [--manual]",
    purpose: "Request all advertised OAuth scopes; print the browser URL to stderr",
  },
  {
    command: "auth finish",
    purpose: "Read the complete callback URL from stdin and verify state and issuer",
  },
  { command: "auth status", purpose: "Show local auth state without exposing credentials" },
  { command: "auth logout", purpose: "Remove only this MCP resource's locally stored credentials" },
  { command: "tools [refresh]", purpose: "Discover every enabled tool and its generated command" },
  {
    command: "<generated-command> --help",
    purpose: "Show live tool description, schema, flags and safety annotations",
  },
  { command: "help / --help", purpose: "Show help without authentication or a configured forum" },
  { command: "version / --version", purpose: "Show the installed version" },
];

export function topHelp() {
  return {
    description: DESCRIPTION,
    usage: "discourse-axi [command] [flags] --forum <base-url>",
    commands: BUILTINS,
    notes: [
      "Forum precedence: --forum, DISCOURSE_AXI_FORUM_URL, then .discourse-forum at this worktree's Git root. No default forum.",
      "Use tools to discover commands; there is no fixed tool list or REST backend.",
      "Tool flags come from JSON Schema; --json '<object>' supports nested input. Unknown flags fail.",
      "Results use TOON; long strings are marked truncated. --full keeps the complete tool response.",
      "No tool call is automatically retried. After an ambiguous write failure, inspect forum state first.",
      "Exit codes: 0 success, 2 invalid usage, 1 operational failure.",
    ],
  };
}

export function createSkillMarkdown() {
  return `---\nname: discourse-axi\ndescription: Use discourse-axi to discover and call the tools enabled by a Discourse forum over MCP.\n---\n\n# Discourse MCP CLI\n\nSelect a forum with \`--forum <base-url>\`, \`DISCOURSE_AXI_FORUM_URL\`, or an explicit repository binding. No default forum exists. Run \`discourse-axi\` for local auth state and a short tool summary.\n\n## Commands\n\n${BUILTINS.map((row) => `- \`discourse-axi ${row.command}\`: ${row.purpose}.`).join("\n")}\n\n## Workflow and safety\n\n1. Run \`auth status\`; if needed, run \`auth login\` and ask the user to approve the browser consent screen. Login requests every advertised scope; the forum decides what the account may grant.\n2. Run \`tools\` and inspect a generated command's \`--help\` before calling it. Plugin tools need no CLI changes.\n3. Read \`readOnly\` and \`destructive\` annotations, but treat them as hints, not permission to mutate. Get user authorization for writes.\n4. Use repeatable array flags and \`--json '<object>'\` for nested input or exact property names. All input is schema-validated.\n5. Output is TOON. Long strings explicitly say they were truncated; use \`--full\` to remove local truncation. Server-side truncation cannot be undone.\n\nCommand names drop a leading \`discourse_\` and use kebab-case. Built-in collisions gain \`tool-\`; remaining collisions get \`-2\`, \`-3\`, etc. in sorted tool-name order. Use \`tools refresh\` after server configuration changes.\n\nNever print credential files or put OAuth callback URLs/codes/tokens in shell history, reports or fixtures. Manual completion reads the entire callback URL from stdin via \`auth finish\`. \`DISCOURSE_AXI_MCP_TOKEN\` bypasses OAuth. Logout removes local credentials only, not server grants or environment tokens.\n\nNo tool call is automatically retried, including after a timeout. Inspect forum state before retrying a write. A tool's \`isError\` response is a failed command, never success data. Exit codes are 0 success, 2 usage, 1 operation failure.\n`;
}
