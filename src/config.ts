import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { usage } from "./errors.ts";

export function safeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usage("Expected an absolute forum or MCP URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  ) {
    throw usage(
      "Use an HTTPS URL without credentials, query or fragment (HTTP is allowed on loopback)",
    );
  }
  return url;
}

export async function gitRoot(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  while (true) {
    try {
      // A worktree has a .git file, not a directory; both are boundaries.
      await access(join(current, ".git"));
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Returns undefined when nothing selects a forum, so the home view can explain setup instead of failing. */
export async function findForum(explicit: string | undefined, env: NodeJS.ProcessEnv, cwd: string) {
  let value = explicit ?? env.DISCOURSE_AXI_FORUM_URL;
  if (!value) {
    const root = await gitRoot(cwd);
    if (root) {
      try {
        value = (await readFile(join(root, ".discourse-forum"), "utf8")).trim();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  if (!value) return undefined;
  const forum = safeUrl(value).href.replace(/\/+$/, "");
  const resource = safeUrl(env.DISCOURSE_AXI_MCP_URL ?? `${forum}/mcp`).href;
  return { forum, resource };
}

export async function resolveForum(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  const selected = await findForum(explicit, env, cwd);
  if (!selected)
    throw usage("No forum configured", [
      "Pass --forum <base-url>, set DISCOURSE_AXI_FORUM_URL, or run `discourse-axi init --forum <url>`",
    ]);
  return selected;
}

export async function bindForum(cwd: string, forum: string, force: boolean) {
  const root = await gitRoot(cwd);
  if (!root)
    throw usage("init requires a Git repository", [
      "Run it inside a Git worktree, or pass --forum <url> or set DISCOURSE_AXI_FORUM_URL instead",
    ]);
  const path = join(root, ".discourse-forum");
  const current = await readFile(path, "utf8").catch(() => undefined);
  // Re-binding the same forum is already satisfied, so it succeeds instead of demanding --force.
  if (current?.trim() === forum) return { status: "unchanged", forum, binding: path };
  try {
    await writeFile(path, `${forum}\n`, { flag: force ? "w" : "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw usage("This repository already has a forum binding", [
        "Use init --forum <url> --force to replace it",
      ]);
    }
    throw error;
  }
  return { status: current === undefined ? "bound" : "replaced", forum, binding: path };
}

export function statePaths(env: NodeJS.ProcessEnv) {
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return {
    auth: env.DISCOURSE_AXI_AUTH_FILE || join(config, "discourse-axi", "oauth.json"),
    cache: join(cache, "discourse-axi"),
  };
}
