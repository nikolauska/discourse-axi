# discourse-axi

An agent-facing CLI for Discourse forums. Every tool returned by the forum's MCP server becomes a command, including plugin and custom tools. MCP-only: no REST backend or built-in forum default.

Requires Node.js 24+. Package: `@nikolauska/discourse-axi`, executable: `discourse-axi`, MIT.

## Install and discover

Build a local package:

```sh
npm ci
npm run check
npm pack
npm install --global ./nikolauska-discourse-axi-0.1.0.tgz
discourse-axi --help
```

Installing the executable does not install agent instructions or change agent configuration. The package includes `skills/discourse-axi/SKILL.md`; install that skill separately through your agent host's supported mechanism. Its source is `src/skill.ts`; regenerate with `npm run build:skill`.

```sh
discourse-axi auth login --forum https://forum.example.org
discourse-axi tools --forum https://forum.example.org
discourse-axi search-posts --help --forum https://forum.example.org
```

`search-posts` is only an example: actual commands, permissions and schemas come from discovery. Run a command only after inspecting its help and getting authorization for any writes.

## Forum selection

Precedence:

1. `--forum <base-url>` (before or after the command).
2. `DISCOURSE_AXI_FORUM_URL`.
3. `.discourse-forum`, containing the URL on one line at this Git worktree's root.

There is no implicit default. Bind a repository explicitly with `discourse-axi init --forum <url>`; use `--force` to replace a binding. Reads never create one. Nested directories resolve the same root; `.git` files work for linked worktrees. The binding is non-secret and ignored by this repository; projects may choose to track it.

The endpoint is `<forum-base>/mcp`. `DISCOURSE_AXI_MCP_URL` overrides it without changing forum selection. URLs must use HTTPS, except loopback HTTP for local development; credentials, query strings and fragments are rejected.

## OAuth

`auth login` discovers protected-resource and authorization-server metadata, requests **all advertised protected-resource scopes**, and prints a browser URL to stderr. Open it and approve access. The forum still limits grants to the account's allowed groups and permissions. The CLI waits up to ten minutes for a loopback callback. Public-client token requests use authentication method `none`, authorization code and PKCE S256, resource binding, random state, and issuer verification.

Client presets, tried in this order:

| client_id     | redirect_uri                          |
| ------------- | ------------------------------------- |
| `codex`       | `http://127.0.0.1/callback` (port 80) |
| `claude-code` | `http://localhost:8080/callback`      |

These exact IDs and URLs are in Discourse's [`CLIENT_PRESETS`](https://github.com/discourse/discourse/blob/bf55a44c2872738f7ae2664d6fec3d6d8779190f/frontend/discourse/admin/components/admin-mcp.gjs). They are forum presets, **not** OpenAI/Anthropic account-login client IDs. They must be pre-registered/approved by the forum administrator; they are not globally registered OAuth identities.

Discourse's [`McpOauthClient#allows_redirect_uri?`](https://github.com/discourse/discourse/blob/bf55a44c2872738f7ae2664d6fec3d6d8779190f/app/models/mcp_oauth_client.rb) accepts changed ports for both loopback IPs and `localhost`, provided the other URI components match. This CLI keeps the exact requested preset URLs. If the port is unavailable or restricted, it offers manual completion instead of silently changing it.

On `invalid_client`, `invalid_redirect_uri` or `redirect_uri_mismatch` from the authorization preflight or a verified OAuth error callback, login automatically starts the Claude Code flow. Consent denial, state mismatch and issuer mismatch do not trigger fallback. A generic error page shown only inside the signed-in browser is not an OAuth error response the CLI can observe; see limitations below. The successful client ID is saved with its grant and reused for refresh.

Manual login:

```sh
discourse-axi auth login --manual --forum https://forum.example.org
discourse-axi auth finish --forum https://forum.example.org
```

For `auth finish`, supply the **complete callback URL on stdin**, then EOF. Use a private stdin pipe or terminal with echo disabled; do not put the URL in command arguments, shell history, logs or issue reports. A bare code is insufficient because state and issuer must be checked. `iss` is required when advertised and always checked when present. A browser may report connection refused in manual mode; copy its callback URL privately rather than retrying authorization.

```sh
discourse-axi auth status --forum https://forum.example.org
discourse-axi auth logout --forum https://forum.example.org
```

Status describes local state, not verified server access. Tokens refresh automatically before MCP connections when their expiry is known. Set `DISCOURSE_AXI_MCP_TOKEN` to use a bearer token directly and bypass stored OAuth credentials. A rejected token produces a login hint; insufficient scope produces a re-login hint.

Credentials live in `$XDG_CONFIG_HOME/discourse-axi/oauth.json`, falling back to `~/.config/discourse-axi/oauth.json`; `DISCOURSE_AXI_AUTH_FILE` overrides the path. The store is keyed by exact MCP resource URL, atomically replaced with mode `0600`, and locked during updates. A crashed writer can leave a `.lock` file; remove it only after confirming the process has stopped. Never put this file inside a repository. Logout removes only the selected resource's local grant and pending login, not other forums, server grants or environment tokens. Revoke server authorization under the forum's user preferences if needed.

See also [Discourse's MCP announcement](https://meta.discourse.org/t/connect-your-ai-apps-to-your-community-with-discourse-s-built-in-mcp-server/412755) and [OAuth implementation](https://github.com/discourse/discourse/blob/bf55a44c2872738f7ae2664d6fec3d6d8779190f/lib/discourse_mcp/oauth.rb).

## Generated commands and validation

Discovery follows every `tools/list.nextCursor`; repeated cursors or duplicate tool names are errors. Command names drop a leading `discourse_`, convert to kebab-case, and sort by original tool name. Names colliding with `auth`, `init`, `tools`, `help` or `version` gain `tool-`. Remaining collisions receive `-2`, `-3`, etc. `tools` always shows the original tool name too.

- String, integer, number, boolean and enum constraints come from JSON Schema.
- Top-level scalar properties become flags; scalar arrays become repeatable flags, one item per occurrence.
- Booleans accept `--flag`, `--flag=true` or `--flag=false`.
- `--flag=value` is supported. Duplicate scalar flags, unknown flags and positional arguments fail.
- Required fields, numeric bounds, enums, arrays, object rules and schema composition are validated before sending.
- `--json '<object>'` passes nested input, unions, arrays of objects, exact property names, and names colliding with CLI flags. A property cannot appear in both JSON and a flag. JSON Schema draft-07, 2019-09 and 2020-12 are supported, with local `$ref` and standard formats. Remote schema references are not fetched.
- Help includes the full input schema and server annotations. `readOnlyHint` and `destructiveHint` are advisory, not permission to mutate.

The catalog is cached for 15 minutes under `$XDG_CACHE_HOME/discourse-axi` (default `~/.cache/discourse-axi`), keyed by forum, MCP resource, granted scopes and an irreversible token fingerprint. This also isolates different accounts and direct tokens whose scopes cannot be discovered. Tokens themselves are not cached. `tools refresh` forces discovery. Unknown generated commands or unknown-tool responses refresh the catalog; a failed call is **never replayed**, even if discovery changes its schema.

## Results, dashboard and errors

No arguments shows the forum, local auth state, tool count and up to eight commands. Logged-out users get login help without an MCP request. `--help` and `--version` work without a forum or network access.

Results use TOON. `isError` always fails. Structured content takes precedence; otherwise JSON text is parsed, then plain text retained. Multiple content blocks and non-text blocks are preserved as data, not rendered as images/audio. Strings longer than 4,000 characters explicitly show truncation; `--full` removes local truncation but cannot recover text omitted by the server. Tool error bodies are not echoed because they can contain submitted secrets.

Progress goes to stderr; results and structured errors go to stdout. Exit codes: `0` success, `2` usage error, `1` operational failure. No tool call is automatically retried after timeout or connection failure. A failed write may have completed: inspect forum state before manually retrying it.

## Limits

- The forum must enable MCP, approve a client preset, and grant the user access. MCP initialization and discovery can require login.
- The CLI cannot detect a client rejection rendered as an HTML page only in an authenticated browser, with no OAuth error callback. Ask the administrator to approve a preset; a browser-only rejection does not justify treating login as successful.
- Remote `$ref` schemas and nonstandard schema dialects are unsupported; an unresolvable schema fails before sending. Complex properties use `--json` rather than invented flags.
- MCP resources, prompts, interactive elicitation and sampling are not CLI commands. This package exposes tools, as requested. Tools requiring client-side interactive capabilities cannot complete through this CLI.

## Development

`npm run check` runs formatting, lint, strict typecheck, generated-skill consistency and local fixture tests. Tests generate fake credentials at runtime and never contact live forums. `npm pack` builds the distributable; CI installs that tarball into a temporary prefix and exercises help. CI has no publishing step.

The installed-package smoke path also works against the local fixture: manual OAuth login with Codex rejection, Claude Code fallback, private-stdin completion, refresh using the saved client, multi-page discovery, generated help and a read-only search. This does not substitute for user-approved live forum verification.
