#!/usr/bin/env node
import { main } from "./cli.ts";
import { usage } from "./errors.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  readInput: async () => {
    // An agent's shell would otherwise block forever on an interactive read.
    if (process.stdin.isTTY)
      throw usage("auth finish reads the callback URL from stdin, which is a terminal", [
        "Pipe it without echo or history: `read -rs callback_url && printf '%s\\n' \"$callback_url\" | discourse-axi auth finish --forum <url>`",
      ]);
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 16_384) throw usage("stdin is larger than a callback URL can be");
    }
    return text;
  },
});
