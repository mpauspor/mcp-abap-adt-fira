# mcp-abap-adt-fira — Agent Instructions

This file is the **single source of truth** for every AI coding agent working in
this repository (Claude, Antigravity, Codex; also Cursor/Cline).
`CLAUDE.md` and `GEMINI.md` only point here. Do not add agent-specific rules
elsewhere; edit this file.

It holds the engineering rules. How the agents coordinate — task board,
decisions, specs, test notes and the orchestrator — lives in a separate notes
repository, the sibling directory `../mcp-abap-adt-Fira-notes`; read its
`AGENTS.md` and `TASKS.md` before you start. If you do not have it, ask the
user: nothing in this repository replaces it.

Keep it under 12,000 characters (Antigravity's rules-file cap).

## 1. Project snapshot

- Fork of [fr0ster/mcp-abap-adt](https://github.com/fr0ster/mcp-abap-adt): an
  MCP server exposing SAP ABAP ADT operations as tools. Package `@mcp-abap-adt/core`.
- This fork adds correctness fixes and ~20 tools (cross-system comparison,
  debugger, ATC, transport checks, includes, local-file I/O). See `README.md`
  for the fork's changes and `README.upstream.md` for base docs.
- Working branch: `fira-main`. Remotes: `myfork` (GitHub `mpauspor/mcp-abap-adt-fira`),
  `upstream` (fr0ster), `origin` (local base clone). Fixes of general value go
  upstream as PRs; fork-specific work stays on `fira-main`.
- Key paths: `src/handlers/` (tool handlers), `src/lib/connection/`,
  `src/lib/`, `src/__tests__/`, `tests/` (integration config), `docs/`.
- Target landscape: SAP 7.5x on-prem. Cloud/BTP paths exist but are not the
  primary target here.

## 2. Git

- Merge into `fira-main` only after `npm run build`, `npm test` and
  `npm run test:check` pass. Never rewrite `fira-main` history.
- Commit messages: conventional commits, English, with a trailer
  `Agent: claude` / `Agent: antigravity` / `Agent: codex`.
- Plans in `docs/superpowers/plans/` stay only while active; delete once
  implemented or cancelled.
- **Secrets never enter the tree:** `sessions/*.env`, `tests/test-config.yaml`,
  `.env*` are gitignored. Never paste SAP hosts, users, passwords, tokens or
  transport numbers into any committed file. This repository is public.

## 3. Language

- All repository artifacts written by an agent (code, comments, docs, commit
  messages, plans) are in **English**.
- Conversation with the user follows the user's language (usually Spanish).

## 4. Commands

```bash
npm install
npm run build          # biome check + tsc -> dist/
npm run build:fast     # tsc only
npm test               # unit tests (jest), SAP-free
npm run test:check     # tsc --noEmit on the test project
npm run lint:check     # biome, read-only
npm run docs:tools     # regenerate docs/user-guide/AVAILABLE_TOOLS*.md
npm run test:fira      # integration tests vs a real system (needs tests/test-config.yaml)
npm run test:integration
```

Gate before declaring a task done: `npm run build`, `npm test`,
`npm run test:check` all exit 0. If a tool definition changed, also run
`npm run docs:tools` and commit the regenerated docs.

## 5. Code standards

- TypeScript, English identifiers; comments explain *why*, not *what*.
- Avoid `any`; types are explicit. Follow existing handler structure:
  one handler per file under `src/handlers/`, registered in the matching
  `src/lib/handlers/groups/*HandlersGroup.ts`.
- Handlers return structured results; no file writes from handler logic except
  the explicit opt-in `to_file` / `source_path` features, and `SetupSystem`
  (writes `<name>.env` in the user's sessions directory with opt-in
  parameters).
- Success is **verified, not inferred**: write tools read the object back and
  compare before reporting `success: true` (see README "Success was asserted,
  not verified"). Keep that discipline for new write tools.

### Tool error contract

A tool that fails **returns** its error; it never throws one.

- Signal failure with `return return_error(err)` (from `lib/utils`). Do not
  hand-build the result and do not prepend `Error:`, `ADT error:` or
  `MCP error -N:`.
- Never `throw new McpError(...)` from a handler and never import `McpError`
  in `src/` (a static test forbids it; the only allowed re-export is in
  `lib/utils.ts`).
- Helpers whose return value is spread into a success payload `throw new
  Error(msg)`; the enclosing handler's `catch` routes it through `return_error`.

### `available_in`

`available_in` in `TOOL_DEFINITION` restricts a tool to SAP environments:
`'onprem' | 'cloud' | 'legacy'`. Omit it unless the tool genuinely does not
work somewhere (Programs are onprem/legacy only, so
`RuntimeRunProgramWithProfiling` is onprem-only; class-based profiling and
dumps work everywhere).

## 6. Working with ABAP objects (fundamental rule)

Never assume the existence of an include, object, function, class or structure
unless it is explicitly present in retrieved code or listed by `GetIncludesList`
(or an equivalent dependency listing). Every analysis statement must point at
real code. If several objects match a name, ask the user which one. Do not
rely on unstated SAP/ABAP "standards"; the user's context wins. Ask when
language, format, structure or location are unspecified.

## 7. Testing

### Unit tests
`npm test`. SAP-free; mock `createAdtClient` from `../../lib/clients` as the
existing tests do. Pure logic (e.g. transport pre-release rules) must be unit
tested, including cases awkward to stage on a real system.

### Integration tests
Run against a real SAP system. Configuration lives in `tests/test-config.yaml`
(gitignored; create from `tests/test-config.yaml.template` with `npm run
test:init`, editing only the lines the template marks as needing a change).

- **Soft mode** (default): handlers called directly. Use for mass regression.
- **Hard mode** (`integration_hard_mode.enabled: true`): spawns the full MCP
  server over stdio. Use only for targeted verification of recent changes.
- Shared SAP objects: `npm run shared:setup` once, `npm run shared:check` to
  verify. Setup needs the user: run it, show the result, ask them to confirm
  activation in ADT. If activation fails, ask what they see; do not retry blindly.
- Always save full output to a log file, never truncate with `tail`. Runs take
  15-25 min: use `timeout 1800` or run in background.

```bash
npm run test:integration 2>&1 | tee /tmp/integration-test.log
npm test -- --testPathPatterns=<specific-test>   # hard mode, targeted
```

Only the include suite writes (in the temporary directory) and cleans up
afterwards.

## 8. Known SAP/ADT facts that shape the code

- Data preview SQL is capped at 255 characters; SAP reports longer statements
  as "Only one SELECT statement is allowed".
- Empty preview cells arrive as self-closing `<dataPreview:data/>`; the parser
  is `XMLParser`-based for that reason. Do not reintroduce regex parsing.
- SAP executes the ACTIVE load: running a class after an unactivated update
  returns the old version. Pre-flight compares active vs inactive source.
- `MANDT` is excluded from cross-system table comparison; a table keyed only by
  client is refused.
- Unauthenticated requests under `/sap/bc/adt` receive the SAP HTML logon page
  (HTTP 200, `<title>Logon</title>`), never HTTP 401. A 401 arrives only when
  credentials were provided and rejected.
- TLS certificates are verified by default. The launcher merges Windows
  certificate store CAs alongside Node's bundled CAs. Setting
  `TLS_REJECT_UNAUTHORIZED=0` (or `NODE_TLS_REJECT_UNAUTHORIZED=0`) turns
  verification off process-wide for every system this server connects to.
- abapGit tools compile but are untested (component absent on the dev system).

## 9. npm package verification

When checking whether an installed package contains specific code, search
inside `node_modules/` directly (`grep -r "pattern" node_modules/@scope/pkg/`).
Editor search and ripgrep skip `node_modules` because of `.gitignore`.

## 10. Environment notes

- Windows host; `--env=<destination>` resolves to
  `%USERPROFILE%\Documents\mcp-abap-adt\sessions\<destination>.env`. The repo
  `sessions/` folder (gitignored) is used by the cross-system tools.
- `SAP_LANDSCAPE_PATH`: optional override for the SAP GUI landscape file path
  (`SAPUILandscape.xml`).
- `SAP_CREDENTIAL_TARGET`: Windows Credential Manager target (e.g.
  `mcp-abap-adt:<name>`), keeping passwords out of `.env` files.
- MCP client configuration templates for Claude Code, Codex and Antigravity
  live in the notes repository (`docs/agents/MCP_SETUP.md`, and Antigravity's
  committed copy at `.agents/mcp_config.json`).
- Legacy rule files `.cursor/rules/main.mdc` and `.clinerules/` are kept for
  Cursor/Cline; their content is covered by sections 3, 5 and 6 above.
