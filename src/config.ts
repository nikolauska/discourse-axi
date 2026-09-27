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

export async function resolveForum(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
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
  if (!value)
    throw usage("No forum configured", [
      "Pass --forum <base-url>, set DISCOURSE_AXI_FORUM_URL, or run `discourse-axi init --forum <url>`",
    ]);
  const forum = safeUrl(value).href.replace(/\/+$/, "");
  const resource = safeUrl(env.DISCOURSE_AXI_MCP_URL ?? `${forum}/mcp`).href;
  return { forum, resource };
}

export async function bindForum(cwd: string, forum: string, force: boolean) {
  const root = await gitRoot(cwd);
  if (!root) throw usage("init requires a Git repository");
  const path = join(root, ".discourse-forum");
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
  return { forum, binding: path };
}

export function statePaths(env: NodeJS.ProcessEnv) {
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return {
    auth: env.DISCOURSE_AXI_AUTH_FILE || join(config, "discourse-axi", "oauth.json"),
    cache: join(cache, "discourse-axi"),
  };
}
