# Forum commands

## Where commands come from

discourse-axi asks the forum for its complete tool list, and each tool becomes a command:

- The `discourse_` prefix is dropped and the name is written with dashes, so `discourse_search_posts` becomes `search-posts`.
- A tool whose name clashes with a built-in command (`auth`, `init`, `tools`, `help`, `update`) gets a `tool-` prefix. Any remaining clashes get `-2`, `-3` and so on.
- `discourse-axi tools` lists every command next to the forum's original tool name. Long descriptions are shortened; `tools --full` shows them in full.

Which commands exist depends on the forum, its plugins, and your account's access.

## Giving inputs

- Simple inputs (text, numbers, true/false, a choice from a list) are flags: `--name value` or `--name=value`.
- A list of simple values is given by repeating the flag once per item.
- True/false flags accept `--name`, `--name=true` or `--name=false`.
- Anything more complex goes in `--json '<object>'`: nested objects, lists of objects, inputs that accept several shapes, and inputs whose names clash with the CLI's own flags. The same input cannot be given both ways.
- Unknown flags, repeating a single-value flag, and extra positional words are errors. Adding `--help` does not rescue an otherwise invalid command line.
- Required inputs, number ranges, allowed values and formats are checked before anything is sent. If the forum's input description cannot be fully understood, the command fails before sending.

## Command help

`discourse-axi <command> --help` (or `-h`) shows each flag with its type, whether it is required, and its limits. It also lists inputs that only `--json` can reach and the forum's hints about whether the tool reads or changes data. `--help --full` adds the forum's complete input description.

The forum's hints are only hints. Writing to the forum still needs the user's permission.

## Keeping the list current

- The command list is kept for 15 minutes in `$XDG_CACHE_HOME/discourse-axi` (or `~/.cache/discourse-axi`), separately for each forum, account and level of access. Tokens are never stored there.
- `discourse-axi tools refresh` fetches a fresh list immediately.
- Running a command the saved list does not know, or a tool the forum says no longer exists, refreshes the list automatically. The failed call itself is never re-sent.

## Updating discourse-axi

`discourse-axi update` upgrades a global install to the latest published version. `discourse-axi update --check` only reports whether a newer version exists.
