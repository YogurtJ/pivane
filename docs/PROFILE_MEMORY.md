# Profile memory adapter (source candidate)

This adapter selects components of **pi-hermes-memory 0.9.9** (MIT) under the
existing Pi 0.87.1 identity. It does **not** load upstream's default extension:
that extension scans the entire Pi sessions root and uses unscoped project paths.
The native JSONL remains the conversation authority; `sessions.db` is a
rebuildable search index. A profile is optional, and an unbound session has no
memory tools, indexing, injection, or generated skill discovery.

## Parent integration

The parent owns profile records, native session binding and worker lifetime.
Mount `mountProfileMemoryRoutes(router, { profiles, agentDir, bundlePath })` from
`server/profile-memory/management.js` **after** the existing access/Origin
middleware. `profiles.getProfile(id)` must return the saved profile record or
null. `agentDir` is the canonical Pi identity root; `bundlePath` is the exact
built bundle installed in a private prefix. Mount under `/api/pi`, so the route
is `GET /profiles/:id/memory?kind=memories|skills&query=&offset=`. It is
read-only, no-store, paged at 50; `ready` means the backend can read the data,
not that a running worker has loaded the saved revision. When an extended
SQLite database exists but no native reader was supplied, status is
`unsupported`. Never infer user permission from this route alone.

The managed web-session extension must `await registerProfileMemory(pi)` from
`server/profile-memory/extension.ts` **inside an async default factory**. Its
startup verification must finish before Pi starts the session. Provide a
validated `PIVANE_AGENT_PROFILE_CONTEXT` only to the one eligible managed RPC
worker, and `PIVANE_HERMES_BUNDLE` as an absolute path to the verified isolated
bundle. Do not add the upstream package to Pi's global settings or extension
paths. Do not change `PI_CODING_AGENT_DIR` or native session directory. The
adapter independently checks the context's profile path, actual native header,
exact single session-bound custom marker, and current manager at tool use.
Missing, copied, conflicting, or disabled bindings fail closed. Parent must
omit the context for no-profile and ephemeral sessions.

Global profile memory lives at `<agentDir>/pivane-profiles/data/<id>/`;
project-specific memory and generated skills at `projects/<sha256(canonical
cwd)>/`. Same-name cwd paths do not alias. Global profile memory and skills
are available across cwd values. `session_search` stores project identity as
full canonical cwd; its optional `project` filter must use that path, not the
basename. The installed shared Pi skill directory is only consulted to refuse
skill shadowing; upstream does not modify it.

## Isolated installation

From a separate private identity/prefix, obtain the official npm tarball:

```sh
npm pack pi-hermes-memory@0.9.9 --pack-destination /private/evidence
PIVANE_PROFILE_MEMORY_ESBUILD=/path/to/installed/esbuild \
  node scripts/profile-memory-build.cjs /private/evidence/pi-hermes-memory-0.9.9.tgz /private/prefix
HOME=/private/identity node scripts/profile-memory-install.cjs /private/prefix
```

The build rejects tarballs other than SHA256
`6a1b71dfa34f40bba6372a4f71dec54cce76be4ae55923d3b83ebfc1c5920c20`
(registry integrity
`sha512-6EfhmlgBuMfN7bQwN+xHMDVwX/Tm0fKKi6X8lAIBZtcjqxS9Of0rboJzmxfO3r+rGMWb71ss4p+dY34aEsJ1dg==`).
It extracts **unmodified upstream source** to a fresh prefix and bundles only
selected modules with esbuild; it never edits `node_modules`. The installer
creates an isolated lockfile, installs with ignored lifecycle scripts, and
verifies FTS5/native `better-sqlite3` against the running Node. Keep that
lockfile with the prefix for subsequent `npm ci`. Native builds on other
platforms must be verified separately. Never reuse the official Pi identity
for installation or testing. The bundle is not an extension to configure
globally; the parent passes its exact path into eligible worker environments.

Before enabling a real profile, back up `<agentDir>/pivane-profiles/`, record
bundle and lockfile hashes, finish active work, and activate only the reviewed
new worker configuration. Rollback removes the new worker env/hook and
management mount while **retaining** all profile data and native sessions.
Do not delete indexes or learned skills as part of rollback. This source
candidate is not deployed or published by this lane.

## Bounds and gaps

- Index eligibility is checked for each native file; awaited startup scans at
  most 5,000 directory entries and indexes at most 20 eligible files. The
  current session is indexed in `agent_settled` and at shutdown. There are no
  deferred timers or LLM background jobs. Files larger than 8 MiB require a
  future bounded streaming parser before indexing.
- `memory.autoLearn=true` is **not implemented**: upstream review can fall back
  to an unscoped child Pi process and its work is not projected into Pivane's
  maintenance lifecycle. Manual `memory_add`/`memory_replace`/`memory_remove`,
  `memory_search`, `session_search`, and `skill_manage` are available when the
  corresponding profile flags are enabled. The parent should not expose an
  enabled auto-learning control as effective until a separately reviewed
  lifecycle integration exists.
- Upstream anchor session search, `/memory-index-sessions`, legacy migration,
  standing instructions, and automatic consolidation are not loaded. Native
  Pi session search outside this adapter is unaffected. Browser browsing
  covers Markdown and, when installed, extended SQLite memory rows; session
  snippets are available to the agent's scoped `session_search` tool, not this
  read-only browser endpoint.
- Tests use synthetic sessions and a disposable Pi identity, not paid models.
  No terminal TUI is presented as a Web UI. Neither profile scoping nor
  project roots are operating-system security sandboxes.
