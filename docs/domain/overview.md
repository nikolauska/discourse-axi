# What discourse-axi is

discourse-axi is a command-line tool that lets AI agents, and the people working with them, use a Discourse forum. It talks to the forum's built-in MCP server. MCP (Model Context Protocol) is a standard way for a service to describe the actions, called tools, that an AI assistant may use. Every tool the forum offers becomes a discourse-axi command.

## Who it is for

- AI agents doing forum work for a user, such as searching, reading topics and posts, and, with the user's permission, writing.
- People setting up those agents for a forum that has MCP enabled.

## What sets it apart

- **No fixed command list.** Commands come from the forum you choose. Tools added by plugins or custom setups appear automatically, and the list matches what your account is allowed to do.
- **MCP only.** It does not use Discourse's REST API, and it has no default forum.
- **Explains itself.** `discourse-axi --help` is the complete reference for agents. Every command has its own `--help` that lists its inputs and rules.
- **Careful with changes and secrets.** It never re-sends a failed call on its own. It treats the forum's "read-only" and "destructive" labels as hints, not as permission to change anything. It does not print tokens or login codes.

## A typical first session

```sh
discourse-axi init --forum https://forum.example.org   # optional: remember the forum for this repository
discourse-axi auth login
discourse-axi tools
discourse-axi search-posts --help
```

`search-posts` is only an example. The commands you get depend on the forum.
