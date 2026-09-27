import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const searchTool: Tool = {
  name: "discourse_search_posts",
  description: "Search posts",
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1 },
      page: { type: "integer", minimum: 1, maximum: 10 },
      mode: { type: "string", enum: ["all", "title"] },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
      ids: { type: "array", items: { type: "integer", minimum: 1 } },
      visible: { type: "boolean" },
      filter: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
};

export async function fixture() {
  const bearer = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const code = randomBytes(24).toString("base64url");
  let origin = "";
  const state = {
    rejectCodex: false,
    repeatCursor: false,
    toolError: false,
    unknownTool: false,
    mcpStatus: 200,
    expire: false,
    disconnect: false,
    authorizationClients: [] as string[],
    tokenClients: [] as string[],
    grantTypes: [] as string[],
    cursors: [] as (string | undefined)[],
    calls: [] as { name: string; arguments: unknown }[],
    challenge: "",
    requestedScopes: "",
    resourceMatches: true,
    pkceMatches: true,
    tools: [
      searchTool,
      {
        name: "custom_inspect",
        description: "Custom plugin tool",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
      },
    ] as Tool[],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["mcp:profile:read", "mcp:content:read", "mcp:content:write"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url.pathname === "/authorize") {
      const client = url.searchParams.get("client_id") ?? "";
      state.authorizationClients.push(client);
      state.requestedScopes = url.searchParams.get("scope") ?? "";
      state.challenge = url.searchParams.get("code_challenge") ?? "";
      if (state.rejectCodex && client === "codex") return json(400, { error: "invalid_client" });
      res.writeHead(200, { "content-type": "text/html" }).end("Approve fixture access");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      state.tokenClients.push(params.get("client_id") ?? "");
      state.grantTypes.push(params.get("grant_type") ?? "");
      state.resourceMatches &&= params.get("resource") === `${origin}/mcp`;
      if (params.get("grant_type") === "authorization_code") {
        state.pkceMatches &&=
          createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url") === state.challenge;
        if (params.get("code") !== code || !state.pkceMatches)
          return json(400, { error: "invalid_grant" });
      } else if (params.get("refresh_token") !== refresh)
        return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: bearer,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: state.expire ? 1 : 3600,
        scope: "mcp:profile:read mcp:content:read",
      });
    }
    if (url.pathname !== "/mcp") return json(404, {});
    if (req.headers.authorization !== `Bearer ${bearer}`)
      return json(401, { error: "unauthorized" });
    if (state.mcpStatus !== 200)
      return json(state.mcpStatus, {
        error: state.mcpStatus === 403 ? "insufficient_scope" : "unauthorized",
      });
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const rpc = JSON.parse(body);
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: rpc.id, result });
    if (rpc.method === "initialize")
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    if (rpc.method === "tools/list") {
      state.cursors.push(rpc.params?.cursor);
      if (!rpc.params?.cursor) return reply({ tools: [state.tools[0]], nextCursor: "second" });
      return reply({
        tools: state.repeatCursor ? [] : state.tools.slice(1),
        ...(state.repeatCursor ? { nextCursor: "second" } : {}),
      });
    }
    if (rpc.method === "tools/call") {
      state.calls.push(rpc.params);
      if (state.disconnect) {
        req.socket.destroy();
        return;
      }
      if (state.unknownTool)
        return json(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: "Unknown tool" },
        });
      if (state.toolError)
        return reply({
          isError: true,
          content: [{ type: "text", text: "Fixture tool rejected the operation" }],
        });
      return reply({
        content: [{ type: "text", text: "not the preferred result" }],
        structuredContent: { posts: [{ id: 42, title: "Fixture evidence", topic_id: 7 }] },
      });
    }
    json(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    resource: `${origin}/mcp`,
    bearer,
    state,
    callback: (authorizationUrl: string, overrides: Record<string, string> = {}) => {
      const authorization = new URL(authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        code,
        state: authorization.searchParams.get("state")!,
        iss: origin,
        ...overrides,
      }).toString();
      return callback.href;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
