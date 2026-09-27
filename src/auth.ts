import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { safeUrl } from "./config.ts";
import { AxiError, loginHint, operation, usage } from "./errors.ts";
import { Metadata, TokenStore } from "./store.ts";
import type { PendingLogin, StoredGrant } from "./store.ts";

// These are Discourse's admin presets, not the clients for signing in to the AI vendors.
export const CLIENTS = [
  { clientId: "codex", redirect: "http://127.0.0.1/callback" },
  { clientId: "claude-code", redirect: "http://localhost:8080/callback" },
] as const;
const rejectedClient: Record<string, true> = {
  invalid_client: true,
  invalid_redirect_uri: true,
  redirect_uri_mismatch: true,
};
const ResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()),
});
const ServerMetadata = Metadata.extend({
  response_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
});
// The forum's authorization code, not this local PKCE state, is the short-lived part: Discourse
// issues it only on approval and expires it after mcp_authorization_code_lifetime_seconds
// (default 300). Local state therefore has to survive however long a human takes to approve.
const PENDING_LIFETIME_MS = 24 * 60 * 60_000;
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});

export class OAuth {
  readonly resource: string;
  readonly store: TokenStore;
  readonly env: NodeJS.ProcessEnv;
  readonly request: typeof fetch;
  constructor(
    resource: string,
    store: TokenStore,
    env: NodeJS.ProcessEnv,
    request: typeof fetch = fetch,
  ) {
    this.resource = resource;
    this.store = store;
    this.env = env;
    this.request = request;
  }

  private async metadata() {
    const resource = new URL(this.resource);
    const protectedUrl = new URL(
      `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`,
      resource.origin,
    );
    const response = await this.request(protectedUrl, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw operation("Cannot discover the MCP protected resource metadata");
    const protectedResource = ResourceMetadata.parse(await response.json());
    if (protectedResource.resource !== this.resource)
      throw operation("OAuth resource metadata does not match the selected MCP URL");
    const issuer = safeUrl(protectedResource.authorization_servers[0]);
    const metadataUrl = new URL(
      `/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`,
      issuer.origin,
    );
    const serverResponse = await this.request(metadataUrl, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!serverResponse.ok) throw operation("Cannot discover the OAuth authorization server");
    const server = ServerMetadata.parse(await serverResponse.json());
    if (server.issuer !== protectedResource.authorization_servers[0])
      throw operation("OAuth issuer metadata mismatch");
    safeUrl(server.authorization_endpoint);
    safeUrl(server.token_endpoint);
    if (
      !server.response_types_supported.includes("code") ||
      !server.code_challenge_methods_supported.includes("S256") ||
      !server.token_endpoint_auth_methods_supported.includes("none")
    ) {
      throw operation(
        "The forum must support authorization code, PKCE S256 and public client authentication (none)",
      );
    }
    return { metadata: Metadata.parse(server), scopes: protectedResource.scopes_supported };
  }

  async begin(index = 0): Promise<{ authorizationUrl: string; pending: PendingLogin }> {
    const discovered = await this.metadata();
    const pending: PendingLogin = {
      ...CLIENTS[index],
      ...discovered,
      verifier: randomBytes(32).toString("base64url"),
      state: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + PENDING_LIFETIME_MS,
    };
    const url = new URL(pending.metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: pending.clientId,
      redirect_uri: pending.redirect,
      resource: this.resource,
      scope: pending.scopes.join(" "),
      state: pending.state,
      code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    // A public preflight can detect protocol rejections, but cannot inspect a signed-in browser's HTML.
    const response = await this.request(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    let error: string | undefined;
    const location = response.headers.get("location");
    if (location) error = new URL(location, url).searchParams.get("error") ?? undefined;
    if (response.headers.get("content-type")?.includes("json")) {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string")
        error = body.error;
    } else await response.body?.cancel();
    if (error && Object.hasOwn(rejectedClient, error)) {
      if (index === 0) return this.begin(1);
      throw operation("Both Discourse OAuth client presets were rejected", [
        "Ask the forum administrator to register codex or claude-code with the documented redirects",
      ]);
    }
    if (response.status >= 400)
      throw operation(`Authorization endpoint rejected the request (HTTP ${response.status})`, [
        "Check the forum's MCP access and registered client policy",
      ]);
    await this.store.update(this.resource, (entry) => ({ ...entry, pending }));
    return { authorizationUrl: url.href, pending };
  }

  async finish(callback: string) {
    const { pending } = await this.store.get(this.resource);
    if (!pending)
      throw usage(`No pending login for ${this.resource}`, [
        "Run `discourse-axi auth login --forum <url>` first; auth finish must select the same forum",
      ]);
    if (pending.expiresAt < Date.now())
      throw usage(`The pending login expired at ${new Date(pending.expiresAt).toISOString()}`, [
        loginHint,
      ]);
    if (!callback.trim()) throw usage("No callback URL was received on stdin");
    let url: URL;
    try {
      url = new URL(callback.trim());
    } catch {
      throw usage("Provide the complete callback URL on stdin, not just its code");
    }
    const redirect = new URL(pending.redirect);
    if (
      url.origin !== redirect.origin ||
      url.pathname !== redirect.pathname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw usage("Callback URL does not match the pending redirect");
    for (const key of ["state", "iss", "code", "error"]) {
      if (url.searchParams.getAll(key).length > 1)
        throw usage("Duplicate OAuth callback parameters");
    }
    if (url.searchParams.get("state") !== pending.state)
      throw usage("OAuth state mismatch; callback rejected");
    const issuer = url.searchParams.get("iss");
    if (
      (pending.metadata.authorization_response_iss_parameter_supported || issuer !== null) &&
      issuer !== pending.metadata.issuer
    )
      throw usage("OAuth issuer mismatch; callback rejected");
    const error = url.searchParams.get("error");
    if (error) {
      if (Object.hasOwn(rejectedClient, error) && pending.clientId === CLIENTS[0].clientId)
        return { status: "pending" as const, ...(await this.begin(1)) };
      throw operation("OAuth authorization was rejected or denied", [loginHint]);
    }
    const code = url.searchParams.get("code");
    if (!code) throw usage("Callback is missing its authorization code");
    const grant = await this.exchange(pending, {
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirect,
    });
    await this.store.update(this.resource, () => ({ grant }));
    return {
      status: "authenticated" as const,
      clientId: grant.clientId,
      redirect: grant.redirect,
      scopes: grant.scopes,
    };
  }

  private async exchange(
    previous: PendingLogin | StoredGrant,
    values: Record<string, string>,
  ): Promise<StoredGrant> {
    const response = await this.request(previous.metadata.token_endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...values,
        client_id: previous.clientId,
        resource: this.resource,
      }),
    });
    if (!response.ok) {
      // Only the standard OAuth error code is read; descriptions may echo request values.
      const body: unknown = await response.json().catch(() => undefined);
      const error =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : undefined;
      if (error === "invalid_grant" && values.grant_type === "authorization_code")
        throw new AxiError(
          "The forum rejected the authorization code: it expired, was already used, or belongs to another login",
          "NOT_AUTHENTICATED",
          [
            "Run `discourse-axi auth login --forum <url>`, approve, and run auth finish right away (forum codes last 300 seconds by default)",
          ],
        );
      if (error === "invalid_grant")
        throw new AxiError("The forum rejected the stored refresh token", "NOT_AUTHENTICATED", [
          loginHint,
        ]);
      throw new AxiError(
        `OAuth token exchange failed (HTTP ${response.status}${error && /^[a-z_]+$/.test(error) ? `, ${error}` : ""})`,
        "NOT_AUTHENTICATED",
        [loginHint],
      );
    }
    const result = TokenResponse.safeParse(await response.json());
    if (!result.success || result.data.token_type.toLowerCase() !== "bearer")
      throw operation("The OAuth server returned an invalid bearer-token response");
    const token = result.data;
    return {
      clientId: previous.clientId,
      redirect: previous.redirect,
      metadata: previous.metadata,
      accessToken: token.access_token,
      refreshToken:
        token.refresh_token ?? ("refreshToken" in previous ? previous.refreshToken : undefined),
      scopes:
        token.scope === undefined ? previous.scopes : token.scope.split(/\s+/).filter(Boolean),
      expiresAt: token.expires_in === undefined ? undefined : Date.now() + token.expires_in * 1000,
    };
  }

  async credentials() {
    if (this.env.DISCOURSE_AXI_MCP_TOKEN)
      return { token: this.env.DISCOURSE_AXI_MCP_TOKEN, scopes: undefined };
    let { grant } = await this.store.get(this.resource);
    if (!grant) throw new AxiError("Not logged in to this forum", "NOT_AUTHENTICATED", [loginHint]);
    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now() + 30_000) {
      if (!grant.refreshToken)
        throw new AxiError("OAuth token expired", "NOT_AUTHENTICATED", [loginHint]);
      grant = await this.exchange(grant, {
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
      });
      const refreshed = grant;
      await this.store.update(this.resource, (entry) => ({ ...entry, grant: refreshed }));
    }
    return { token: grant.accessToken, scopes: grant.scopes };
  }

  async status() {
    if (this.env.DISCOURSE_AXI_MCP_TOKEN) return { status: "environment-token", verified: false };
    const { grant, pending } = await this.store.get(this.resource);
    if (!grant) {
      if (pending && pending.expiresAt > Date.now())
        return {
          status: "login-pending",
          clientId: pending.clientId,
          pendingExpiresAt: new Date(pending.expiresAt).toISOString(),
        };
      return { status: "not-logged-in" };
    }
    return {
      status: grant.expiresAt !== undefined && grant.expiresAt <= Date.now() ? "expired" : "stored",
      verified: false,
      clientId: grant.clientId,
      redirect: grant.redirect,
      scopes: grant.scopes,
      refreshAvailable: Boolean(grant.refreshToken),
    };
  }
}

export async function callbackListener(redirect: string) {
  const url = new URL(redirect);
  let complete!: (value: string) => void;
  let fail!: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", url.origin);
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || path.pathname !== url.pathname) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain" })
      .end("Callback received. Check discourse-axi for the result; you can close this tab.");
    complete(path.href);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // localhost is bound explicitly, never to all interfaces.
    server.listen(Number(url.port || 80), url.hostname, resolve);
  });
  const timer = setTimeout(
    () =>
      fail(
        operation("Login timed out", [
          "Use auth finish with the callback URL on stdin, or start a new login",
        ]),
      ),
    10 * 60_000,
  );
  return {
    callback,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}
