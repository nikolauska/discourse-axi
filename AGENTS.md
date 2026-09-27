# AGENTS.md

This repository builds `discourse-axi`, an agent-facing CLI generated from Discourse MCP discovery. Work in the repository root. It has no REST backend and no fixed tool catalog.

## Working on the CLI

- Use Node.js 24+ and npm. Install with `npm ci`; include `package-lock.json` when dependencies change.
- Source is TypeScript ESM in `src/`. Keep strict typing, explicit flag validation, TOON output, and AxiError error codes. Runtime dependencies and streams are injectable through `src/cli.ts`.
- `src/skill.ts` supplies built-in help and the shipped skill. Run `npm run build:skill` after changing it; commit `skills/discourse-axi/SKILL.md` rather than editing the generated file directly.
- Finish behavior end to end, exercise the affected CLI path, and fix failures caused by the change. Local tests use disposable loopback fixtures and may be run, fixed and rerun without pausing. `npm test` runs them; `npm run check` adds formatting, lint, typecheck and generated-skill consistency.
- Read README.md when changing authentication, command generation or packaging; update the documented contract with the code.

## State and external effects

- Forum selection is explicit: flag, environment, then `.discourse-forum` at the worktree's Git root. Only `init` writes a binding.
- Never inspect or print real credential files, token values, authorization codes or callback URLs containing codes. Keep test credentials generated at runtime and stored only outside the repository.
- Never retry an ambiguous tool call automatically. MCP annotations are hints, not user permission to write.
- Live forum mutations, publishing, uploads, pushes and hosting files require explicit authorization. CI checks and packs; it does not publish.
