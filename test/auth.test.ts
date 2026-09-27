import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuth } from "../src/auth.ts";
import { TokenStore } from "../src/store.ts";
import { fixture } from "./fixture.ts";

async function setup(t: test.TestContext) {
  const server = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "discourse-auth-"));
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = new TokenStore(join(directory, "oauth.json"));
  const auth = new OAuth(server.resource, store, {});
  return { server, store, auth };
}

test("rejected Codex falls back before consent; refresh retains Claude client and granted scopes", async (t) => {
  const { server, store, auth } = await setup(t);
  server.state.rejectCodex = true;
  server.state.expire = true;
  const started = await auth.begin();
  assert.deepEqual(server.state.authorizationClients, ["codex", "claude-code"]);
  assert.equal(started.pending.redirect, "http://localhost:8080/callback");
  assert.equal(server.state.requestedScopes, "mcp:profile:read mcp:content:read mcp:content:write");
  const result = await auth.finish(server.callback(started.authorizationUrl));
  assert.equal(result.status, "authenticated");
  await auth.credentials();
  assert.deepEqual(server.state.tokenClients, ["claude-code", "claude-code"]);
  assert.deepEqual(server.state.grantTypes, ["authorization_code", "refresh_token"]);
  assert.equal(server.state.pkceMatches, true);
  assert.equal(server.state.resourceMatches, true);
  const saved = await store.get(server.resource);
  assert.equal(saved.grant?.clientId, "claude-code");
  assert.deepEqual(saved.grant?.scopes, ["mcp:profile:read", "mcp:content:read"]);
  assert.equal(saved.pending, undefined);
});

test("verified client-error callback starts fallback but consent denial does not", async (t) => {
  const { server, auth } = await setup(t);
  const started = await auth.begin();
  assert.equal(started.pending.clientId, "codex");
  assert.equal(started.pending.redirect, "http://127.0.0.1/callback");
  const fallback = await auth.finish(
    server.callback(started.authorizationUrl, { error: "invalid_client" }),
  );
  assert.equal(fallback.status, "pending");
  assert.deepEqual(server.state.authorizationClients, ["codex", "claude-code"]);
  if (fallback.status !== "pending") return;
  await assert.rejects(
    auth.finish(server.callback(fallback.authorizationUrl, { error: "access_denied" })),
    /rejected or denied/,
  );
  assert.deepEqual(server.state.tokenClients, []);
});

test("state, issuer, duplicate state and callback origin mismatches cannot exchange codes", async (t) => {
  const { server, auth } = await setup(t);
  const started = await auth.begin();
  await assert.rejects(
    auth.finish(server.callback(started.authorizationUrl, { state: "wrong" })),
    /state mismatch/,
  );
  await assert.rejects(
    auth.finish(server.callback(started.authorizationUrl, { iss: "https://wrong.example" })),
    /issuer mismatch/,
  );
  const missingIssuer = new URL(server.callback(started.authorizationUrl));
  missingIssuer.searchParams.delete("iss");
  await assert.rejects(auth.finish(missingIssuer.href), /issuer mismatch/);
  await assert.rejects(
    auth.finish(`${server.callback(started.authorizationUrl)}&state=wrong`),
    /Duplicate/,
  );
  const wrongOrigin = new URL(server.callback(started.authorizationUrl));
  wrongOrigin.hostname = "localhost";
  await assert.rejects(auth.finish(wrongOrigin.href), /does not match/);
  assert.deepEqual(server.state.tokenClients, []);
});

test("token store isolates resources, enforces 0600 and removes only selected resource", async (t) => {
  const { server, auth, store } = await setup(t);
  const started = await auth.begin();
  await auth.finish(server.callback(started.authorizationUrl));
  const saved = await store.get(server.resource);
  const other = "https://other.example/mcp";
  await store.update(other, () => saved);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  await store.update(server.resource, () => undefined);
  assert.deepEqual(await store.get(server.resource), {});
  assert.equal((await store.get(other)).grant?.clientId, "codex");
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
});

test("environment bearer bypasses OAuth and pending state is resource-bound and expires", async (t) => {
  const { server, auth, store } = await setup(t);
  const direct = new OAuth(server.resource, store, { DISCOURSE_AXI_MCP_TOKEN: server.bearer });
  assert.equal((await direct.credentials()).token, server.bearer);
  assert.deepEqual(server.state.authorizationClients, []);
  const started = await auth.begin();
  const other = new OAuth("https://other.example/mcp", store, {});
  await assert.rejects(other.finish(server.callback(started.authorizationUrl)), {
    code: "VALIDATION_ERROR",
  });
  await store.update(server.resource, (entry) => ({
    ...entry,
    pending: { ...started.pending, expiresAt: 0 },
  }));
  await assert.rejects(auth.finish(server.callback(started.authorizationUrl)), {
    code: "VALIDATION_ERROR",
  });
  assert.deepEqual(server.state.tokenClients, []);
});

test("a login approved long after auth login still finishes; a rejected forum code needs re-login", async (t) => {
  const { server, auth } = await setup(t);
  const started = await auth.begin();
  // The forum's code clock starts at approval, so a slow human must not expire local state.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 45 * 60_000 });
  await assert.rejects(
    auth.finish(server.callback(started.authorizationUrl, { code: "expired-or-used" })),
    { code: "NOT_AUTHENTICATED" },
  );
  const result = await auth.finish(server.callback(started.authorizationUrl));
  assert.equal(result.status, "authenticated");
});
