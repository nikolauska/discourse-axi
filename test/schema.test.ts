import test from "node:test";
import assert from "node:assert/strict";
import { toolArguments } from "../src/args.ts";
import { commands } from "../src/catalog.ts";
import { preview, resultValue } from "../src/mcp.ts";
import { searchTool } from "./fixture.ts";

test("generated flags preserve scalar types, repeated arrays and nested JSON", () => {
  const result = toolArguments(searchTool, [
    "--query=needle",
    "--page",
    "2",
    "--mode",
    "title",
    "--tags",
    "one",
    "--tags=two",
    "--ids",
    "7",
    "--visible=false",
    "--json",
    '{"filter":{"name":"exact"}}',
  ]);
  assert.deepEqual(result.input, {
    query: "needle",
    page: 2,
    mode: "title",
    tags: ["one", "two"],
    ids: [7],
    visible: false,
    filter: { name: "exact" },
  });
});

test("invalid required, enum, integer, bounds, array, nested and unknown inputs fail before execution", () => {
  const cases = [
    [],
    ["--query", ""],
    ["--query", "x", "--mode", "wrong"],
    ["--query", "x", "--page", "1.5"],
    ["--query", "x", "--page", "0"],
    ["--query", "x", "--page", "11"],
    ["--query", "x", "--page", "Infinity"],
    ["--query", "x", "--page", "9007199254740992"],
    ["--query", "x", "--tags", "a", "--tags", "b", "--tags", "c"],
    ["--query", "x", "--ids", "0"],
    ["--query", "x", "--visible=no"],
    ["--qurey", "x"],
    ["--query", "x", "--query", "y"],
    ["--query", "x", "--json", '{"extra":true}'],
    ["--json", "[]"],
    ["--query", "x", "--json", '{"filter":{}}'],
    ["--query", "x", "--json", '{"query":"y"}'],
  ];
  for (const args of cases)
    assert.throws(() => toolArguments(searchTool, args), { code: "VALIDATION_ERROR" });
});

test("local refs, schema composition and reserved property names work through JSON", () => {
  const tool = {
    name: "plugin",
    inputSchema: {
      type: "object" as const,
      $defs: { choice: { type: "integer", minimum: 3 } },
      properties: {
        full: { type: "string" },
        selection: { $ref: "#/$defs/choice" },
        nested: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["full", "selection"],
    },
  };
  assert.deepEqual(
    toolArguments(tool, ["--json", '{"full":"property","selection":3,"nested":4}']).input,
    { full: "property", selection: 3, nested: 4 },
  );
  assert.throws(() => toolArguments(tool, ["--json", '{"full":"property","selection":2}']), {
    code: "VALIDATION_ERROR",
  });
});

test("built-in and normalization collisions remain individually addressable regardless of page order", () => {
  const tools = [
    "discourse_auth",
    "discourse_search_posts",
    "search-posts",
    "tool-auth",
    "discourse_help",
  ].map((name) => ({ name, inputSchema: { type: "object" as const } }));
  const forward = commands(tools);
  assert.deepEqual([...forward], [...commands([...tools].reverse())]);
  assert.equal(forward.get("tool-auth")?.name, "discourse_auth");
  assert.equal(forward.get("tool-auth-2")?.name, "tool-auth");
  assert.equal(forward.get("search-posts-2")?.name, "search-posts");
  assert.equal(forward.get("tool-help")?.name, "discourse_help");
});

test("tool errors cannot become success even with structured content", () => {
  assert.throws(
    () =>
      resultValue({
        isError: true,
        structuredContent: { ok: true },
        content: [{ type: "text", text: "rejected" }],
      }),
    { code: "OPERATION_ERROR" },
  );
  assert.throws(
    () => resultValue({ isError: true, content: [{ type: "text", text: "insufficient_scope" }] }),
    { code: "FORBIDDEN" },
  );
});

test("structured content wins; JSON, plain and mixed content remain useful", () => {
  assert.deepEqual(
    resultValue({
      structuredContent: { correct: true },
      content: [{ type: "text", text: '{"wrong":true}' }],
    }),
    { correct: true },
  );
  assert.deepEqual(resultValue({ content: [{ type: "text", text: '{"id":42}' }] }), { id: 42 });
  assert.deepEqual(resultValue({ content: [{ type: "text", text: "Long readable post" }] }), {
    text: "Long readable post",
  });
  assert.deepEqual(
    resultValue({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: '{"id":7}' },
      ],
    }),
    {
      content: [
        { type: "text", text: "first" },
        { type: "json", value: { id: 7 } },
      ],
    },
  );
  const full = { post: "x".repeat(4001) };
  assert.deepEqual(preview(full, false), {
    post: `${"x".repeat(4000)}\n[truncated 1 characters; use --full]`,
  });
  assert.equal(preview(full, true), full);
});
