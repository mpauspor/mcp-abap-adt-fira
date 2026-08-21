# mcp-abap-adt-fira

A fork of **[fr0ster/mcp-abap-adt](https://github.com/fr0ster/mcp-abap-adt)** — an
MCP server that lets an AI assistant work with an ABAP system over ADT.

This fork keeps everything the original does and adds correctness fixes plus 20
tools, all developed and verified against a live SAP 7.5x landscape. Base
installation, configuration and the full tool catalogue are documented in the
original project; see [README.upstream.md](./README.upstream.md).

Licensed MIT, same as the original. Copyright for the base work remains with
Oleksii Kyslytsia — see [LICENSE](./LICENSE).

---

## Why this fork exists

Three of the bugs fixed here did not raise an error. They returned a plausible
answer that was wrong, which is the kind of defect that survives longest because
nobody thinks to check.

The most consequential one silently misattributed query results to the wrong
row. If you use `GetSqlQuery` or `GetTableContents` from the base project, that
one is worth knowing about regardless of whether you adopt this fork — it has
been submitted upstream as
[PR #179](https://github.com/fr0ster/mcp-abap-adt/pull/179).

---

## Correctness fixes

### Query results were misaligned across rows

SAP emits an empty cell in the data preview payload as a **self-closing**
`<dataPreview:data/>`. The regex-based parser did not match that form, so empty
cells were dropped, the column's array came back short, and **every value below
the first empty one moved up a row**.

Reproducible with standard SAP tables on any system:

```sql
SELECT FIELDNAME, CHECKTABLE FROM DD03L WHERE TABNAME = 'E070'
```

Eight of the nine `CHECKTABLE` cells are empty. The one real value belongs to
`STRKORR`, the last row, and was reported against `AS4USER`, the first.

| | Before | After |
|---|---|---|
| `AS4USER` → `CHECKTABLE` | `"E070"` ❌ | `""` |
| `STRKORR` → `CHECKTABLE` | `null` ❌ | `"E070"` |

`GetTableContents` imports the same parser and was equally affected. Rewritten
with `XMLParser`; empty strings and `"0"` are preserved rather than turned into
`null`, NUMC keys keep their leading zeros, and duplicate column names in a JOIN
get a suffix instead of overwriting one another.

### Includes could not be written at all

`UpdateProgram` addressed `/sap/bc/adt/programs/programs/`, which is the wrong
ADT resource for an include. Lock, PUT and unlock all succeeded and **nothing
was written**, while the tool reported success.

There was no include write path anywhere: the ADT client library implements only
the read half. This fork adds `UpdateInclude` (lock → PUT → unlock → read back
and verify), and `UpdateProgram` now refuses an include instead of pretending.

### "Success" was asserted, not verified

Write tools inferred `success: true` from the absence of an exception, which is
a different claim. Thirteen source-carrying `Update*` tools now read the object
back and compare before reporting success.

Objects edited through structured metadata rather than source — domains, data
elements, message classes, function groups, service bindings — cannot be
byte-compared, since SAP generates their payload. They are checked a different
way: four of the five accept a `description`, which is read back and compared,
so the check confirms the value that landed. `UpdateServiceBinding` writes no
comparable field, so it is verified by SAP's change timestamp advancing.

A read that fails is reported as unverified rather than as an error, since a
read problem is not a write problem. Only positive evidence — a value that came
back different, or a timestamp that never moved — fails the call.

### Transport requests were silently created as LOCAL

The client wrapped the target system in slashes (`tm:target="/QAS/"`), which SAP
rejects, and passed the owner through in lowercase, which SAP does not
recognise. The request was created as LOCAL and the tool reported the target
that had been asked for. It now posts directly, uppercases the owner, and warns
when SAP assigns a different target than requested.

### Includes could not be activated

The object-URI map had no entry for `PROG/I`, so activation fell through to a
path that does not exist. Activating as `PROG` instead produced
"REPORT/PROGRAM statement is missing". Activation success was also computed as
`activated && checked`, which reports failure for an object that was already
active and needed no work.

### Running a class returned the previous version

SAP executes the ACTIVE load. After an update without activation, the run
returned the old version's output as though it were current. A pre-flight now
compares the active and inactive sources and refuses with an explanation.

---

## New capabilities

### Cross-system comparison

Answers "has this reached QAS yet, and is it the same in production?" over a
second read-only connection resolved from `sessions/<name>.env`.

- `ListSystems` — which systems are reachable
- `CompareObjectAcrossSystems` — unified diff for one object
- `ComparePackageAcrossSystems` — a whole package against one target
- `ComparePackageAcrossLandscape` — one call walks an ordered chain and reports
  how far each object has travelled

Two design notes. It compares **source, not version numbers** — ABAP version
counters are per-system and unrelated across a landscape. And when a downstream
system matches while an upstream one does not, that is reported as
`out_of_band` rather than "promoted": it means something was changed outside the
transport chain, which is precisely what you want surfaced.

Function groups are expanded into their function modules and includes. Without
that a typical custom package reports almost nothing, since a `FUGR` has no
source of its own.

### Objects too large for a tool call

A 165 KB report cannot be passed as a tool argument, and reading one back
consumes an enormous share of the context window. Since the server runs on the
user's own machine, it can use the filesystem directly:

```
GetProgram    → to_file=/tmp/report.abap     (source to disk, summary returned)
   edit the file
UpdateProgram → source_path=/tmp/report.abap
```

`source_path` is available on 15 `Update*` tools; `to_file` on read-shaped
tools. Both opt-in. A UTF-8 BOM is stripped on read — Windows editors add one,
and a BOM before `REPORT` is a syntax error invisible in the editor that wrote
it.

### ABAP debugger

`DebuggerSetBreakpoint`, `DebuggerListen`, `DebuggerGetStack`,
`DebuggerGetVariable`, `DebuggerStep`, `DebuggerStop`,
`DebuggerListBreakpoints`, `DebuggerDeleteBreakpoint`.

Multiple breakpoints coexist: a `POST` to that endpoint replaces the entire set
for an IDE identity, and its `GET` is a *synchronize* relation that returns
conflicts rather than a listing, so the current set cannot be read back. The
server keeps its own registry and re-sends the full set on every change.
Variables come back parsed — name, value, type, length — rather than as raw XML.

**A breakpoint set in SAP GUI will not work.** It is a session breakpoint: the
classic debugger handles it and ADT never sees it. Use
`DebuggerSetBreakpoint`, and **trigger the code over HTTP or RFC** —
`RuntimeRunProgram`, `RuntimeRunClass`, an OData service. A report started from
SAP GUI goes to the classic debugger and the listener waits forever.

### Transport release

`ReleaseTransport`, so releasing no longer means leaving the tool for SE01. SAP
answers `200` even for a request that does not exist, so success is taken from
`tm:releasetimestamp` rather than the HTTP status.

### abapGit

`AbapGitListRepos`, `AbapGitGetRepo`, `AbapGitGetErrorLog`, `AbapGitLink`,
`AbapGitPull`, `AbapGitUnlink`, wrapping the client already present in the
dependency. **Untested**: the system this fork was developed against does not
have the ADT abapGit component installed.

---

## Status

| Area | State |
|---|---|
| Query parser | Fixed, unit tests, reproduced and verified live |
| Includes | Verified live, end to end |
| Write verification | Verified live (13 source tools + 5 metadata tools) |
| Transports | Create and release verified live |
| Activation | Verified live |
| Cross-system comparison | Verified live across three systems |
| Local files | Verified live |
| Debugger | Full cycle verified live |
| abapGit | Compiles; component absent on the test system |

557 unit tests, 43 integration tests.

```bash
npm test                  # unit
npm run test:fira         # integration, needs tests/test-config.yaml
```

Integration tests run against a real system. Only the include suite writes, in
`$TMP`, and cleans up afterwards.

---

## Known limitations

- TLS verification is a process-wide setting, so a secondary system inherits
  whatever the server was started with.
- Package comparison is bounded by a safety cap. A large package expands to
  thousands of comparable units; use `object_types` to narrow it.

---

## Relationship to the original

This fork tracks `fr0ster/mcp-abap-adt` and aims to send fixes upstream rather
than diverge. Fixes of general value are submitted as pull requests; the query
parser fix is [PR #179](https://github.com/fr0ster/mcp-abap-adt/pull/179).

For installation, configuration, transports, authentication and the full
catalogue of the base tools, use the original project's documentation:
[README.upstream.md](./README.upstream.md) and [docs/](./docs).
