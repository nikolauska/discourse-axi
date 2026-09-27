# Signing in

discourse-axi signs in with OAuth, the standard "approve this app in your browser" flow.

## Normal login

`discourse-axi auth login`:

1. Asks the forum what access it offers and requests all of it.
2. Prints a link to open in the browser (on stderr).
3. You approve access. The forum still limits it to what your account's groups and permissions allow.
4. The CLI waits up to ten minutes for the browser to return to a local address on your machine, then saves the login.

If that local address cannot be opened, for example because the port is in use or restricted, the CLI returns `login-pending` straight away and you finish with `auth finish` (see below). It never quietly switches to a different port.

## Client presets

The forum administrator has to approve the client that discourse-axi signs in as. It tries these in order:

| client_id     | redirect_uri                          |
| ------------- | ------------------------------------- |
| `codex`       | `http://127.0.0.1/callback` (port 80) |
| `claude-code` | `http://localhost:8080/callback`      |

These are Discourse's own built-in [client presets](https://github.com/discourse/discourse/blob/bf55a44c2872738f7ae2664d6fec3d6d8779190f/frontend/discourse/admin/components/admin-mcp.gjs). They are not OpenAI or Anthropic account logins, and they work only when the forum has them enabled.

If the forum clearly rejects `codex` (it reports an unknown client or a wrong return address), the CLI starts a `claude-code` login automatically. Denying access, or a failed security check, does not trigger this. The preset that worked is remembered and reused when the login is refreshed.

## Manual completion

```sh
discourse-axi auth login --manual
read -rs callback_url && printf '%s\n' "$callback_url" | discourse-axi auth finish
```

After you approve, the browser may show "connection refused". That is expected in manual mode. Copy the full address from the browser's address bar and pass it through standard input as shown.

- Give the complete address, not just the code. The CLI checks that it belongs to this login and this forum.
- `auth finish` refuses to wait for typed input; the address must be piped in.
- Keep the address out of command arguments, shell history, logs and issue reports. It works like a one-time password.

## Time limits

- A pending login stays valid for 24 hours. Starting a new `auth login` replaces it.
- The forum's one-time approval code expires much sooner: after 300 seconds by default in Discourse, and never more than 600 (site setting `mcp_authorization_code_lifetime_seconds`). Run `auth finish` right after approving.
- An expired or already used code fails with `NOT_AUTHENTICATED`. Run `auth login` and approve again.

## Checking and ending a login

- `auth status` shows the forum, the MCP address in use, and the saved login state. It only reads what is saved locally; it does not ask the forum whether access still works.
- Saved logins refresh automatically before connecting when their expiry time is known.
- A rejected token leads to a hint to log in. Missing permissions lead to a hint to log in again.
- `auth logout` removes the saved and pending login for the selected forum only, and reports whether anything was removed. It does not revoke access on the forum; do that in your forum user preferences.
- `DISCOURSE_AXI_MCP_TOKEN` supplies a token directly and skips saved logins. `auth logout` warns while it is still set.

## Where logins are saved

- `$XDG_CONFIG_HOME/discourse-axi/oauth.json`, or `~/.config/discourse-axi/oauth.json` when `XDG_CONFIG_HOME` is not set. `DISCOURSE_AXI_AUTH_FILE` overrides the path.
- The file is readable only by you. Never place it inside a repository.
- A crash while saving can leave a `.lock` file next to it. Delete it only after making sure no discourse-axi process is still running.

More background: [Discourse's MCP announcement](https://meta.discourse.org/t/connect-your-ai-apps-to-your-community-with-discourse-s-built-in-mcp-server/412755).
