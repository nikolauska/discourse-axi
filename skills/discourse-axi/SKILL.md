---
name: discourse-axi
description: "Read and act on a Discourse forum (topics, posts, search, chat, users, moderation) through the discourse-axi CLI, whose commands are generated from the forum's MCP tools. Use whenever a task touches a Discourse forum. Do not use for other forum software."
---

# discourse-axi

Agent-facing Discourse CLI over MCP; commands come from the selected forum's tools.

If `discourse-axi` is not installed, ask the user to install it with `npm install -g @nikolauska/discourse-axi` (Node.js 24 or newer).

The CLI documents itself; read its help instead of guessing:

- `discourse-axi` shows the selected forum, auth state, a tool summary and the next command.
- `discourse-axi --help` covers forum selection, login, workflow, output, exit codes and safety rules.
- `discourse-axi <command> --help` shows a command's flags and required inputs, including every generated forum tool.
- Follow the `help:` hints in responses and errors.

## Rules

- Get the user's authorization before any write; tool annotations are hints, not permission.
- Never print credential files, tokens, or OAuth callback URLs and codes.
