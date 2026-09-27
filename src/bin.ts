#!/usr/bin/env node
import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  readInput: async () => {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 16_384) throw new Error("Input too large");
    }
    return text;
  },
});
