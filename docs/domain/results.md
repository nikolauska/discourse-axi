# Results and errors

## The dashboard

Running `discourse-axi` with no arguments shows the forum, the login state, how many tools the forum offers, up to eight commands, and the command to run next.

- With no forum chosen, it explains how to choose one.
- When you are not logged in, it shows login help without contacting the forum's MCP server.
- `--help` (`-h`), `--version` (`-v`) and help for built-in commands work without a forum or a network connection.
- Suggested commands include `--forum` only when you gave the forum that way, not when it came from the environment or a repository binding.

## Output

- Results are printed in TOON, a compact text format that is easy for agents to read.
- Text longer than 4,000 characters is shortened with a visible marker. `--full` turns off this shortening but cannot bring back anything the forum left out.
- The forum's structured result is shown when there is one. Otherwise JSON text is parsed, and plain text is kept as it is. Multiple parts and non-text parts such as images or audio are kept as data, not displayed.
- If the forum marks a result as an error, the command fails. The forum's error details are not repeated, because they may contain what you submitted, including secrets.
- Results and errors (`error`, `code`, `help`) go to stdout. Login links and diagnostics go to stderr.

## Exit codes

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | Success, including requests that were already satisfied |
| `2`  | Usage or input error                                    |
| `1`  | Operational failure: sign-in, network, forum or tool    |

## Timeouts and retries

- Connecting and listing tools time out after 30 seconds, running a tool after 60 seconds, and sign-in network requests after 30 seconds.
- Nothing is retried automatically. A write that failed or timed out may still have gone through, so check the forum before trying it again.
