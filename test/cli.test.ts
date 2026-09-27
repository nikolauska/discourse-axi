import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { resolveForum } from "../src/config.ts";
import { fixture } from "./fixture.ts";

async function setup(t: test.TestContext) {
  const server = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "discourse-cli-"));
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const env = {
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
    DISCOURSE_AXI_FORUM_URL: server.origin,
    DISCOURSE_AXI_MCP_TOKEN: server.bearer,
  };
  const run = async (args: string[], customEnv: NodeJS.ProcessEnv = env) => {
    let stdout = "",
      stderr = "";
    const exit = await main(args, {
      cwd: directory,
      env: customEnv,
      stdout: {
        write: (text) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
      readInput: async () => "",
    });
    return { exit, stdout, stderr };
  };
  return { server, directory, env, run };
}

test("real MCP discovery follows pages and generated plugin commands execute", async (t) => {
  const { server, run } = await setup(t);
  const list = await run(["tools"]);
  assert.equal(list.exit, 0, list.stdout);
  assert.match(list.stdout, /search-posts/);
  assert.match(list.stdout, /custom-inspect/);
  assert.deepEqual(server.state.cursors, [undefined, "second"]);
  const help = await run(["search-posts", "--help"]);
  assert.match(help.stdout, /--query/);
  assert.match(help.stdout, /readOnlyHint: true/);
  assert.equal(server.state.calls.length, 0);
  const call = await run(["search-posts", "--query", "needle", "--page", "2"]);
  assert.equal(call.exit, 0, call.stdout);
  assert.match(call.stdout, /Fixture evidence/);
  assert.doesNotMatch(call.stdout, /not the preferred/);
  assert.deepEqual(server.state.calls[0], {
    name: "discourse_search_posts",
    arguments: { query: "needle", page: 2 },
  });
  assert.equal((await run(["custom-inspect"])).exit, 0);
  assert.equal(server.state.calls[1].name, "custom_inspect");
  assert.deepEqual(server.state.cursors, [undefined, "second"]);
});

test("repeated discovery cursor terminates instead of looping", async (t) => {
  const { server, run } = await setup(t);
  server.state.repeatCursor = true;
  const result = await run(["tools"]);
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /repeated.*cursor/);
  assert.deepEqual(server.state.cursors, [undefined, "second"]);
});

test("schema errors never reach a tool; isError is an operational failure", async (t) => {
  const { server, run } = await setup(t);
  assert.equal((await run(["search-posts", "--query", "x", "--page", "0"])).exit, 2);
  assert.equal((await run(["search-posts", "--query", "x", "--unknown"])).exit, 2);
  assert.equal(server.state.calls.length, 0);
  server.state.toolError = true;
  const result = await run(["search-posts", "--query", "x"]);
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /OPERATION_ERROR/);
});

test("401 and 403 during initialize have actionable login hints", async (t) => {
  const { server, run } = await setup(t);
  server.state.mcpStatus = 401;
  const denied = await run(["tools"]);
  assert.equal(denied.exit, 1);
  assert.match(denied.stdout, /NOT_AUTHENTICATED/);
  assert.match(denied.stdout, /auth login/);
  server.state.mcpStatus = 403;
  const insufficient = await run(["tools"]);
  assert.equal(insufficient.exit, 1);
  assert.match(insufficient.stdout, /FORBIDDEN/);
  assert.match(insufficient.stdout, /Re-run/);
});

test("unknown server tool refreshes catalog without replaying the call", async (t) => {
  const { server, run } = await setup(t);
  await run(["tools"]);
  server.state.unknownTool = true;
  const result = await run(["search-posts", "--query", "x"]);
  assert.equal(result.exit, 1);
  assert.equal(server.state.calls.length, 1);
  assert.deepEqual(server.state.cursors, [undefined, "second", undefined, "second"]);
});

test("ambiguous disconnect never retries an unannotated mutation", async (t) => {
  const { server, run } = await setup(t);
  server.state.tools[1] = { name: "plugin_write", inputSchema: { type: "object", properties: {} } };
  server.state.disconnect = true;
  const result = await run(["plugin-write"]);
  assert.equal(result.exit, 1);
  assert.equal(server.state.calls.length, 1);
  assert.match(result.stdout, /no tool call was automatically retried/);
});

test("tools refresh and cache identity prevent stale scopes or credentials sharing discovery", async (t) => {
  const { server, run, env } = await setup(t);
  await run(["tools"]);
  server.state.tools[1] = { name: "new_plugin", inputSchema: { type: "object", properties: {} } };
  assert.doesNotMatch((await run(["tools"])).stdout, /new-plugin/);
  assert.match((await run(["tools", "refresh"])).stdout, /new-plugin/);
  const rejected = await run(["tools"], {
    ...env,
    DISCOURSE_AXI_MCP_TOKEN: randomBytes(32).toString("base64url"),
  });
  assert.equal(rejected.exit, 1);
  assert.match(rejected.stdout, /NOT_AUTHENTICATED/);
});

test("missing forum fails; unauthenticated dashboard and top help need no network", async (t) => {
  const { server, run, env } = await setup(t);
  const empty = { HOME: env.HOME };
  const missing = await run([], empty);
  assert.equal(missing.exit, 2);
  assert.match(missing.stdout, /No forum configured/);
  assert.equal((await run(["--help"], empty)).exit, 0);
  assert.equal((await run(["auth", "login", "--help"], empty)).exit, 0);
  assert.equal((await run(["tools", "--manual", "--help"], empty)).exit, 2);
  assert.equal((await run(["auth", "logout", "--force", "--help"], empty)).exit, 2);
  const loggedOut = await run([], { ...env, DISCOURSE_AXI_MCP_TOKEN: undefined });
  assert.equal(loggedOut.exit, 0);
  assert.match(loggedOut.stdout, /auth login/);
  assert.deepEqual(server.state.cursors, []);
});

test("worktree binding stays local and explicit flag overrides environment and binding", async (t) => {
  const { directory, run, env, server } = await setup(t);
  await writeFile(join(directory, ".git"), "gitdir: /not-used-by-binding-lookup\n");
  await mkdir(join(directory, "nested"));
  assert.equal((await run(["init", "--forum", server.origin])).exit, 0);
  assert.equal((await readFile(join(directory, ".discourse-forum"), "utf8")).trim(), server.origin);
  assert.equal((await resolveForum(undefined, {}, join(directory, "nested"))).forum, server.origin);
  assert.equal(
    (
      await resolveForum(
        undefined,
        { ...env, DISCOURSE_AXI_FORUM_URL: "https://environment.example" },
        directory,
      )
    ).forum,
    "https://environment.example",
  );
  assert.equal(
    (await resolveForum("https://explicit.example", env, directory)).forum,
    "https://explicit.example",
  );
  assert.equal((await run(["init", "--forum", "https://replacement.example"])).exit, 2);
  assert.equal((await run(["init", "--forum", "https://replacement.example", "--force"])).exit, 0);
  assert.equal((await resolveForum(undefined, {}, directory)).forum, "https://replacement.example");
});
