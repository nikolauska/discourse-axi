---
name: discourse-axi
description: Use discourse-axi to discover and call the tools enabled by a Discourse forum over MCP.
---

# Discourse MCP CLI

Select a forum with `--forum <base-url>`, `DISCOURSE_AXI_FORUM_URL`, or an explicit repository binding. No default forum exists. Run `discourse-axi` for local auth state and a short tool summary.

## Commands

- `discourse-axi init --forum <url> [--force]`: Bind this Git worktree to a forum (writes .discourse-forum).
- `discourse-axi auth login [--manual]`: Request all advertised OAuth scopes; print the browser URL to stderr.
- `discourse-axi auth finish`: Read the complete callback URL from stdin and verify state and issuer.
- `discourse-axi auth status`: Show local auth state without exposing credentials.
- `discourse-axi auth logout`: Remove only this MCP resource's locally stored credentials.
- `discourse-axi tools [refresh]`: Discover every enabled tool and its generated command.
- `discourse-axi <generated-command> --help`: Show live tool description, schema, flags and safety annotations.
- `discourse-axi help / --help`: Show help without authentication or a configured forum.
- `discourse-axi version / --version`: Show the installed version.

## Workflow and safety

1. Run `auth status`; if needed, run `auth login` and ask the user to approve the browser consent screen. Login requests every advertised scope; the forum decides what the account may grant.
2. Run `tools` and inspect a generated command's `--help` before calling it. Plugin tools need no CLI changes.
3. Read `readOnly` and `destructive` annotations, but treat them as hints, not permission to mutate. Get user authorization for writes.
4. Use repeatable array flags and `--json '<object>'` for nested input or exact property names. All input is schema-validated.
5. Output is TOON. Long strings explicitly say they were truncated; use `--full` to remove local truncation. Server-side truncation cannot be undone.

Command names drop a leading `discourse_` and use kebab-case. Built-in collisions gain `tool-`; remaining collisions get `-2`, `-3`, etc. in sorted tool-name order. Use `tools refresh` after server configuration changes.

Never print credential files or put OAuth callback URLs/codes/tokens in shell history, reports or fixtures. Manual completion reads the entire callback URL from stdin via `auth finish`. `DISCOURSE_AXI_MCP_TOKEN` bypasses OAuth. Logout removes local credentials only, not server grants or environment tokens.

No tool call is automatically retried, including after a timeout. Inspect forum state before retrying a write. A tool's `isError` response is a failed command, never success data. Exit codes are 0 success, 2 usage, 1 operation failure.
