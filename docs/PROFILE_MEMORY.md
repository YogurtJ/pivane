# Profile memory adapter (source candidate)

The adapter uses selected components from **pi-hermes-memory 0.9.9** (MIT) with
Pi 0.87.1. It never loads upstream's default factory: that factory scans the
shared Pi sessions root, migrates global state, and may spawn an unscoped Pi
child. Native JSONL is the conversation authority. Profile-local `sessions.db`
is a disposable derived search index, not a parallel chat transcript tree.

## Integration contract

Parent mounts `mountProfileMemoryRoutes(router, { profiles, getAgentDir, bundlePath })`
from `server/profile-memory/management.js` under `/api/pi`, after access and
Origin middleware. `profiles.getProfile(id)` is **async** and returns a saved
record or null; `getAgentDir()` is **async** and returns the canonical Pi identity
root; `bundlePath` is a trusted absolute installed bundle path or a synchronous
`(): string | null` callback. The read-only route is
`GET /profiles/:id/memory?kind=memories|skills&query=&offset=`. It returns
`missing`, `disabled`, `unsupported`, `error`, or `ready`; `ready` only means
this backend can read installed profile data, not that a worker has loaded the
saved revision. `missing` covers an absent profile or absent initialized root;
`unsupported` covers a missing/incompatible adapter. It returns no invented
source provenance. Pagination is 50, with bounded files, rows and query length.
Distinct SQLite rows keep distinct IDs; the revision hashes logical rows (also
when changes are still in SQLite WAL), plus the bytes of Markdown/skill files.

For `/api/pi/status`, the parent can call
`profileMemoryCapability({ bundlePath, reviewModel })`, exported by the same
module, and publish its `{ installed, autoLearn }` result as `profileMemory`.
`reviewModel` is the same JSON string as the worker's
`PIVANE_PROFILE_MEMORY_REVIEW_MODEL` configuration. `autoLearn` is false if no
model is configured; this capability does **not** prove credentials or a
completed review. Actual per-worker loaded-state remains A's separate signal;
actual per-review completion/failure is a native
`pivane-profile-review` custom entry with `{version,profileId,status,reason,at,provider?,modelId?,usage?}`.
The receipt includes only bounded reported token counts and provider-reported total USD cost
when the provider supplies them, even when a charged proposal is rejected. No
conversation body, credential or proposal text is stored in the receipt. Absent usage
is omitted, not estimated. Neither this receipt nor a nested boundary model call contributes
to normal native session usage totals; a parent-owned ledger integration would be required.
A zero model-catalogue price is not evidence of free service and is rejected for review.

The managed web-session extension must **await** `registerProfileMemory(pi)`
inside an async default factory. Provide `PIVANE_AGENT_PROFILE_CONTEXT` only
to the matching eligible managed RPC worker, and `PIVANE_HERMES_BUNDLE` as the
verified isolated bundle's absolute path. Do not configure upstream globally,
change `PI_CODING_AGENT_DIR`, or create a second worker for a native session.
No-profile, disabled, missing, or ephemeral sessions must not receive context.
The adapter verifies the context against the real native binding and physical
session before registration/use. Forks retain an old parent marker as well as
one matching current-ID marker; only current-ID markers count. Imported copied
markers never bind a new ID. No-profile sessions receive no adapter tools,
injection, indexing, discovery or review.

Global profile memory and generated skills live under
`<agentDir>/pivane-profiles/data/<id>/`, with cwd-specific stores beneath
`projects/<sha256(canonical cwd)>/`. Global memory/skills cross project cwd;
project memory/skills do not alias same-name cwd folders. Installed shared Pi
skills are read-only when refusing a skill collision; profile skill operations
reject symlinks in their owned trees. The active agent's
`skill_manage` guidance recommends deliberate profile-only skill improvements
after useful procedures or corrections. Pi discovers newly created skills
after session reload. The memory and learned-skill flags are independent.

## Auto-learning

`memory.autoLearn` has no effect unless memory is enabled, a valid bound RPC
worker is active, and `PIVANE_PROFILE_MEMORY_REVIEW_MODEL` is configured as
JSON `{ "provider": "configured-provider", "modelId": "cheap-model-id" }`.
Select a configured provider/id from the Pi runtime catalogue; no model is
hardcoded and the current conversation model is never silently substituted.
The model must resolve as available via `ctx.modelRegistry` and have input
price at most 1 and output price at most 2 per million tokens. Parent should
choose a cheaper model explicitly and inspect its actual schema/cost. A review
runs only after three eligible completed turns, at most once per 15 minutes and
four attempts per worker session. It reads at most 6,000 characters of the latest user/assistant
exchange, requests at most 220 output tokens with a supported low reasoning
level (or no reasoning option for a non-reasoning model), no tools, a 20-second
abort signal, and no CLI/subagent fallback. Pi awaits
`agent_before_settle`, so a request still in flight remains owned; timeout
requests cancellation but the handler awaits actual completion. It applies at
most one bounded stable fact through the guarded `memory_add` operation. All adapter
memory add/replace/remove writes across workers acquire the same profile-local
interprocess mutation lock. The reviewer takes a revision and disk snapshot under
that lock, releases it for the provider call, then reacquires it to reload, compare
revision/content and perform the write. A stale proposal is skipped; a busy or
abandoned lock fails closed and requires operator reconciliation rather than unsafe
lock stealing. Abort, unavailable model, malformed proposal, conflicting state
and write uncertainty record non-success. This is not a
mastery/progress inference engine. Native custom status entries are operational
records, not additional chat logs. Provider cancellation behavior must be
verified for each selected provider before real activation.

## Source index and bounds

A single opened no-follow native descriptor supplies the validated historical
bytes used for parsing and indexing. BigInt identity, kernel descriptor path,
type, size, mtime/ctime and path identity are checked before and after.
`sessionPath` must be supplied for factory-time registration and must equal
the live read-only SessionManager's `getSessionFile()` at startup. Without a
canonical native path, the extension remains inert; the parent supplies it for
eligible managed workers. Active binding is
verified by streaming the actual descriptor and inspecting its native header
and current-ID markers, independent of history discovery or the 8 MiB index
snapshot cap. An active conversation exceeding that cap retains memory and
skill tools, while its transcript is not indexed. A profile-local
`pivane_sources` table binds each derived session row to the verified native
path and content fingerprint. Replacing session rows, upstream messages/file
metadata and provenance is one SQLite transaction, with a fresh source check
inside it even when another worker supplied an older candidate. Legacy
unproven derived rows are removed. Search
reconciles all tracked sources before and after querying; deleted, edited,
rebound or replaced sources cannot leak old snippets. A change detected after
query preparation fails the result and asks for retry. Indexing advances a
persisted cursor through bounded batches at startup and after settled turns,
including sources beyond the first 20 or 5,000. It never scans raw JSONL
through the upstream anchor fallback. Tool results report partial coverage while the
initial sweep is unfinished, a source exceeds the historical byte cap, or a
verified candidate cannot be indexed. Ineligible foreign/no-profile files do
not by themselves make coverage partial. At most 8 MiB per historical native session is eligible for the derived index;
this is not an active-session/tool limit. A search rejects verification beyond
5,000 tracked rows or 64 MiB read budget
rather than returning unchecked data. Oversized native histories remain
unindexed and visibly partial; no full-recall promise is made. Cwd must remain
resolvable. The source candidate has not been deployed.

## Isolated installation

Use the pinned upstream tarball; its SHA256 is
`6a1b71dfa34f40bba6372a4f71dec54cce76be4ae55923d3b83ebfc1c5920c20`
(npm integrity
`sha512-6EfhmlgBuMfN7bQwN+xHMDVwX/Tm0fKKi6X8lAIBZtcjqxS9Of0rboJzmxfO3r+rGMWb71ss4p+dY34aEsJ1dg==`).
The reviewed isolated lock at `server/profile-memory/upstream-lock.json` has
SHA256 `4f242aaee52d1be13c1d9a795d77595a2f6ef0070d18cf7546f21b01d7a2881b`.
Parent must add this JSON lock to `distributionFiles()` (server source discovery
currently includes only JS/MJS/TS), and add this document to the public docs
manifest before packaging. The installer rejects a different lock, creates a
fresh prefix, runs `npm ci
--ignore-scripts` for that locked graph, then runs only pinned `better-sqlite3`
trusted native rebuild and checks the real Node ABI/FTS5. Dependencies,
LICENSE and license metadata remain in the isolated prefix. It never patches
`node_modules`, modifies real Pi settings or enables upstream as a global Pi
package. Use a private identity and an empty prefix; do not install under the
running service during this review.

```sh
npm pack pi-hermes-memory@0.9.9 --pack-destination /private/evidence
PIVANE_PROFILE_MEMORY_ESBUILD=/path/to/esbuild \
  node scripts/profile-memory-build.cjs /private/evidence/pi-hermes-memory-0.9.9.tgz /private/fresh-prefix
HOME=/private/disposable-identity node scripts/profile-memory-install.cjs /private/fresh-prefix
PIVANE_TEST_HERMES_BUNDLE=/private/fresh-prefix/package/profile-memory-bundle.mjs \
PIVANE_TEST_PI_JITI=/private/fresh-prefix/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti \
  node --test test/pi-profile-memory*.test.js
```

These tests require both variables; integration is not silently skipped in the
parent gate. Keep the prefix and record its bundle, lock and native hashes.
Before enabling a real profile, finish active work and back up
`<agentDir>/pivane-profiles/` and configuration. Parent activates only reviewed
new workers under its maintenance flow. Rollback removes the hook/env/router
and keeps profile data and native sessions. This lane has not deployed or
published the adapter. Node 22 ARM64, macOS and Windows native ABI remain
separate platform verification gates; the evidence here is Node 24 Linux ARM64.
