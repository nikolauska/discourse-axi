# Limits

- The forum must have MCP enabled, the administrator must approve a client preset, and your account must have access. Connecting and listing tools may require a login.
- If the forum rejects the client only with an error page in the browser, without sending an OAuth error back, discourse-axi cannot see the rejection and cannot fall back to another preset. Ask the administrator to approve a preset; do not treat the login as successful.
- Input descriptions that point to remote definitions, or use nonstandard schema versions, are not supported. Such commands fail before sending. Complex inputs use `--json` instead of made-up flags.
- Only MCP tools become commands. MCP resources, prompts, interactive questions from the forum (elicitation) and sampling are not supported, so tools that need them cannot finish through discourse-axi.
