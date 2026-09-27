# Choosing a forum

Every command works against one forum. discourse-axi picks it in this order:

1. `--forum <base-url>`, placed before or after the command.
2. The `DISCOURSE_AXI_FORUM_URL` environment variable.
3. A `.discourse-forum` file at the root of the current Git worktree, containing the forum URL on one line.

There is no default forum. If none is chosen, running `discourse-axi` explains how to pick one.

## Binding a repository

`discourse-axi init --forum <url>` writes the `.discourse-forum` file. It is the only command that writes it; reading commands never create one.

- Running it again with the same forum succeeds without changing anything.
- Replacing a binding with a different forum requires `--force`.
- Subdirectories use the same binding, and linked Git worktrees work too.
- The file holds no secrets. Projects may commit it or ignore it.

## Forum addresses

- discourse-axi connects to `<forum-base>/mcp`. `DISCOURSE_AXI_MCP_URL` points it to a different MCP address without changing which forum is selected.
- Addresses must use HTTPS. Plain HTTP is allowed only for loopback addresses (the local machine) during development.
- Addresses containing a username or password, a query string (`?...`) or a fragment (`#...`) are rejected.
