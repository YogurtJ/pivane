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
after session reload. The memory and learned-skill flags are independent. Each saved profile may also set
`memoryCharLimit` (256..65536, default 16000) and `userCharLimit`
(256..32768, default 8000) within `memory`. Server context, worker runtime
verification and both global/project MemoryStore instances carry those actual
limits; no other profile inherits them. They are core character caps, not
history or token budgets. Lowering a cap never removes existing Markdown; its
used count can exceed the saved limit until the user intentionally edits it.
Saved configuration is distinct from already loaded worker configuration.

`mountProfileDocumentRoutes(router,{profiles,getAgentDir,bundlePath})` adds
GET/PUT `/profiles/:id/documents`. The global native `MEMORY.md` and `USER.md`
are read as-is, including entry separators and metadata; only bounded full
documents can be written. USER can be initialized with memory disabled, while
MEMORY requires the memory flag. PUT requires both the document revision and
saved profile revision; it uses the same profile-local interprocess mutation
lock/generation as agent writes. A changed generation invalidates stale
auto-learning proposals. With memory installed and enabled, PUT verifies an
unambiguous old Markdown identity for each fact, publishes the document, and
transactionally updates only those exact global target/project-null/category-null
SQLite rows; distinct SQLite-only facts and other scopes remain unchanged.
Missing old mirror rows (for example USER saved before memory was enabled)
are not conflicts: the edit inserts any missing desired facts, including
retained unchanged facts. Duplicate exact rows or category conflicts still
return 409 before publication. GET checks the actual read-only SQLite rows
before reporting `indexSynced:true`; absence of a pending marker alone is not
proof. An unsynced document also blocks matching worker memory searches and
writes until a revisioned PUT reconciles it. A failure after
publication returns 503 with `documentSaved:true,indexSynced:false` and the
current document snapshot, not a false claim that the write was undone. A
private per-target pending marker blocks affected worker memory search/writes;
PUT of the same current content and fresh revisions deterministically repairs
the index before accepting further edits. If a process stopped after marking
but before publishing, a fresh PUT may discard the plan only while the native
file still matches its verified `before` revision; a published `after` plan or
an unknown third revision remains gated. GET reports `indexSynced:false` while
pending. USER editing with memory disabled/unavailable can save the document
without indexing and returns 202 with explicit index status. This route does
not write project Markdown, unrelated SQLite-only facts or learned skills.
Routes must be mounted under existing same-origin access middleware; a saved
document does not reload running workers.

The learned-skill list (`GET /profiles/:id/memory?kind=skills`) includes
`scope:profile|project` and `source:profile-owned` for each item; project
items may include their opaque hashed `projectKey`. It does not include bodies
or infer an author. `GET /profiles/:id/skills/:skillId` accepts only the
opaque ID from that list, scans bounded verified profile-owned skill roots,
and returns `ready`, `missing`, `disabled` or `unsupported`. A ready item adds
the verified `content` and its file `revision`; no shared installed skill or
arbitrary path can be read through the route.

## Unified knowledge management (source candidate)

`mountProfileKnowledgeRoutes(router, { service })` mounts same-origin GET
`/profiles/:id/knowledge?kind=memory|skill&query=&offset=&sessionId=`, GET
`/profiles/:id/knowledge/items/:itemId`, GET `/profiles/:id/knowledge/injection?sessionId=`, and POST
`/profiles/:id/knowledge/mutations`. The service is
`new ProfileKnowledgeService({ profiles, getAgentDir, bundlePath })` from
`server/profile-memory/knowledge-service.js`; mount it once and pass the **same
instance** to background learning and the native tool adapter. The UI does not
own a second store. GET pages contain at most 50 entries (memory previews up to
512 characters), 30 recent receipts, and a hash revision; detail content is
bounded to 65,536 characters and marks truncated legacy entries read-only.
`offset` is a canonical decimal integer from 0 to 100000 (no leading zeros).
`capabilities.operations` lists supported commands, and `memory`/`skill` flags
specify which kind is writable. The additive `capabilities.journal` object
reports live receipt/request/tombstone counts, their windows and real limits.
`projectWrites:false` still means HTTP cannot write project memory without a
session; `projectWritesBySession:true` (memory enabled and installed) means it can
with a verified `sessionId` (below). Only a verified native source or a verified
session can write the physical cwd scope. No logical assistant
project isolation is claimed. Installed Pi skills are never writable.

POST accepts `{requestId,expectedRevision,operation,kind,...}` with operations
`create|update|delete|restore|enable|disable|undo|consolidate`. Create/update require
explicit content; memory requires category `fact|preference|correction|failure|procedure`.
Skill names are lowercase slugs of at most 64 characters. Updates and state
changes require `itemId` and `itemRevision`; undo requires `receiptId` and
current snapshot revision, not item identity. The receipt reports saved state,
index readiness, activation timing and an undo token; it does not claim a
running worker has reloaded. Undo is only offered while the receipt stays
inside the active journal window and the target revision is unchanged;
receipts compacted into the archive report `undoable:false`. A deleted/replaced memory leaves a tombstone, so
an automatic or repeated create cannot silently revive it. The older whole-document
PUT checks the same private ledger under its existing mutation lock: it cannot
remove managed facts or reintroduce tombstoned ones, while unrelated legacy
entries remain editable. SQLite-only rows,
legacy failure entries and oversized records remain visible but read-only,
with distinct identities from the Markdown they may mirror. Legacy
`failures.md` records are never remapped into the `memory` target.

Each new receipt adds `origin` (`manual` for the HTTP route, `agent` or
`learning` for the native path), `learningReason`
(`correction|review|extraction|manual`, learning only), `preview` (memory: the
body after the change, or the removed body on delete, first 160 characters;
skill: `name`, plus ` — ` and the first 120 characters of a non-empty
description) and, for memory, the resulting `category`. `summary` is unchanged.
Archived receipt digests keep `origin` but not `preview`; older receipts have
none of these fields. A `ready` snapshot with memory enabled adds
`usage: { memory: {chars, limit}, user: {chars, limit}, failure?: {chars, readOnly: true} }`
for the global documents (`failure` only when a legacy `failures.md` exists;
project memory usage is not reported). `chars` is measured like the write-time
check (the entries joined by the `\n§\n` separator) and `limit` is the saved
profile cap. A write that would exceed the cap is refused with 409
`code: 'memory-full'` and `details: {target, chars, limit, needed}` (`needed` is
the length after the write); the HTTP JSON error body carries `code` and
`details` next to `error`.

`operation:'consolidate'` (HTTP `mutate()` only; `mutateFromNative` and the agent
tools refuse it) takes `{kind:'memory', target:'memory'|'user', items:[{itemId,
itemRevision}], content, category}` with 2–20 distinct items. Every item must be
active, writable, profile scope, of the requested target and at its stated
revision, otherwise the whole batch is refused with 409 and nothing is written.
`content`/`category` are validated like create, and the merged body must differ
from every source. One document publication removes all sources and appends the
merged entry; the cap is checked on the merged document (`memory-full` as above).
Each source body becomes a tombstone, so learning cannot write it back. The
receipt has `operation:'consolidate'`, `origin:'manual'`, `itemId` (the merged
entry), `consolidated` (the source IDs) and the merged `preview`; the earlier
receipts of the sources are marked `superseded`. Undo of that receipt checks the
merged entry and every source's current revision, restores all sources and
retires the merged entry in one publication, lifts the sources' tombstones and
tombstones the merged body; this undo receipt is itself `undoable:false`. The
before-copies of a consolidation are held on the merged and each source record;
when the history budget gives them up the receipt becomes `undoable:false`.
Publication uses the same pending marker (it carries the whole next journal), so
a failure after publication is repaired by retrying the same requestId and input.

HTTP project memory edits use `scope:'project', sessionId` with `kind:'memory'`
and `create|update|delete|undo`; a client `projectKey` is still refused. The
service finds the unique native file `*_<sessionId>.jsonl` under the sessions
root, streams its header and custom entries (64 MiB budget, 413 beyond it), and
requires exactly one current-ID binding to this profile and a canonical header
cwd. The server derives `projectKey=sha256(cwd)` and repeats the proof (same file
identity, cwd and binding) immediately before publication, so a session rebound
to another profile or moved to another cwd in between is refused. These edits
only touch that cwd's project items; their receipts are `origin:'manual'` with
`source:{sessionId}` (no `entryId`), and their request IDs follow the client
7-day validity rule. Consolidation and restore are not available this way.

`GET /profiles/:id/knowledge/injection` is read-only. It renders the next turn's
block with the bundle `MemoryStore.formatForSystemPrompt` and, with `sessionId`,
`formatProjectBlock(cwd)` for the physical cwd proven from that session as above
(never a client cwd), joined exactly like the extension. Stores are loaded only
from existing canonical directories whose Markdown passes the private-file
checks before and after loading; missing directories are not created. It returns
`{version:1, status, block, chars, entries, profile:{chars,entries},
project:{chars,entries}|null, lastRead}`; `status` is `ready`, `pending`,
`disabled`, `missing` or `unsupported`; `block` is cut at 64 KiB on a UTF-8
character boundary with `truncated:true` while `chars` stays the full length.
`lastRead` is the latest `pivane-profile-memory-read` entry for this profile in
that session: `{at, generation, provided, chars?, entries?}`, or null.

`service.mutateFromNative(profileId, input, { sessionPath, sessionId, entryId,
cwd }, { origin, reason }?)` is **server/worker-only**. The optional fourth
argument sets the receipt origin (`agent` by default, or `learning` with an
optional `reason`); `input` itself cannot carry an origin. Both its first check and the final check
immediately before publication run a streaming source proof over the opened
native JSONL: descriptor read with before/after identity checks, header session
id and canonical cwd, exactly one current-ID profile binding marker, and the
claimed `entryId` on the current leaf branch. The leaf follows Pi
`SessionManager` semantics (the last appended entry, walking `parentId` to the
root), so an entry on an abandoned branch, or a branch switch between the two
checks, is rejected while same-branch growth is not. The proof retains only
entry `id`/`parentId` edges, never message bodies, and budgets 64 MiB / 200,000
entries per session; over-budget sessions fail explicitly with `Native session
exceeds source proof limits` (413) instead of proving a truncated tree. The
historical derived index keeps its separate 8 MiB snapshot bound. It writes
only `{sessionId,entryId}` into the item and receipt; no conversation text is
duplicated.
For project scope the service derives `projectKey=sha256(canonical cwd)` and
writes the profile-owned physical project directory; the caller cannot choose
an unrelated projectKey. Only this method can create a skill in `draft` state;
manual enable publishes the validated skill after review. The HTTP mutation
method rejects all `source`, `projectKey`, and draft state fields. The single
adapter `createKnowledgeMemoryTools(service, profileId)` in
`server/profile-memory/tool-mutations.js` (registered by
`server/profile-memory/extension.ts`) maps native memory add/replace/remove and
skill create/update/edit/patch/delete writes into this entry. Its native source
must come from a verified worker and a real native entry, and it returns `null`
for read-only skill actions, so upstream `view` lists and reads profile-owned skills. Upstream
project IDs `project:<projectName>:<slug>` resolve by slug inside the verified cwd scope only. Structured skill updates locate exactly
one active skill by `skill_id`, refuse ambiguous matches and unmanaged
frontmatter, patch only a uniquely matching `##` section, and keep the
`itemRevision` CAS between the located snapshot row and the service mutation.
Deterministic rejections (4xx: name collisions, invalid fields, revision
conflicts) return a failed tool result (`details.success=false` with a readable
error, plus `details.code` and `details.errorDetails` when the service gives a
structured code such as `memory-full`) like upstream tools; uncertain outcomes
(5xx or publication-unknown errors) keep throwing and are never reported as a
clean success or failure.
Agent `target: "failure"` writes become ordinary profile `MEMORY.md` entries
(target `memory`, scope `profile`) and are injected on the next turn. An
optional `failure_reason` (trimmed, at most 200 characters, single line) is
appended as `<content>（原因：<reason>）`, and the result must still pass content
validation. Upstream categories map as `failure`/`tool-quirk` → `failure`,
`correction` → `correction`, `preference` → `preference`, `convention` →
`procedure`, `insight` or none → `fact`, except that a failure write without a
category is `failure`. `memory_replace` keeps the old category unless a category
is given or the target is `failure`. Replace/remove with `target: "failure"`
match the same unique writable `memory` entry by exact text; matching only a
legacy `failures.md` entry is refused with 409 `Legacy failure entries are
read-only`. The upstream tool schemas and prompts are unchanged.

The journal and pending publication marker are private profile data protected
by the same cross-process mutation lock and generation as the Markdown/SQLite
writer. An uncertain publication returns an error and `snapshot.status=pending`
until a retry with the identical requestId and input verifies whether the
file is the expected before or after revision. After publication, that retry
repairs indexing/metadata; before publication, it safely retries the write.
A different request cannot pass an unresolved marker. The journal is stored
as version 2: a monotonic `sequence` feeds the hash revision, so receipt
compaction never invalidates client revisions. At most 200 recent receipts
stay active; older receipts are compacted to digest-only archive entries that
keep their identity, request ID and status but report `undoable:false`. Every
request ID keeps a minimal idempotent record. Client request IDs have an
explicit 7-day validity: within it a retry replays the same receipt, after it
the same ID is refused as expired (`Request ID expired`) and is never
re-executed. Server-generated IDs (`tool-*`, `learning-*`, reachable only
through the verified native path) stay replayable while retained and are
compacted oldest-first. Retired IDs are remembered in a spent hash list, so
re-execution stays refused even after compaction. Deleted or replaced memory
content keeps a long-lived tombstone in a compact hash list (32,768 entries).
Only client request IDs enter the permanent spent list; server IDs never
recur, so they are dropped when compacted. Undo before-copies are kept only for
receipts inside the active window and are removed with the receipt that owns
them. The journal, and the pending marker that also carries the next document,
must stay inside 8 MiB: when whole skill bodies would exceed that budget, the
oldest before-copies are dropped first and their receipts become
`undoable:false`, never silently undoable without data. When a real identity
limit (tombstones, spent IDs, records) is reached the service refuses the write
with an explicit journal-full error instead of silently shedding identity. Version 1 metadata still reads with
the same revision, idempotency and tombstone semantics and upgrades to
version 2 atomically on the first write; writing continues past the old
200-receipt cap without any reviewed migration. The learning action journal
follows the same policy: client action request IDs are valid for 7 days,
replays inside the window are idempotent, expired reuse is refused without
re-running the action, and retired IDs stay remembered in a spent hash list;
learning job IDs are server-generated and never collide with client request
IDs, and the state file reports its real `maxActions`/`actionValidityDays`
limits. A saved document is not evidence of successful indexing or activation in an already-running worker.

## Content scan

Pivane's own write paths do not call the upstream `MemoryStore`/`SkillStore`
write methods, so they carry the equivalent check themselves.
`server/profile-memory/content-scan.js` runs on every knowledge `create`,
`update` and `consolidate` (memory content; skill name, description and body),
which covers manual web edits, background learning and Agent tool writes routed
through the knowledge service, and on the entries a full-document editor save
adds (existing entries never block an edit). It ports upstream 0.9.9
`content-scanner.ts` (MIT): invisible Unicode, English injection/exfiltration
phrases and credential shapes, plus Chinese injection phrases and newer key
prefixes. Unlike upstream, a bare variable name such as `OPENAI_API_KEY` is
allowed. A refusal is `400 {code:'content-blocked', details:{rule, kind}}` with
`kind` `secret` or `injection`; the message never echoes the matched text.
Restoring or undoing an older entry does not re-scan it.

## Background learning

The old in-worker three-turn reviewer (`memory.autoLearn`,
`PIVANE_PROFILE_MEMORY_REVIEW_MODEL`, `runtime.json.reviewModel`) is retired:
those values are still read for compatibility but start no model call, and
`/status.profileMemory.autoLearn` is always false. Learning now runs in the
server-side `ProfileLearningService` (`server/profile-memory/learning-service.js`),
which shares the single `ProfileKnowledgeService` instance with the routes and
tool adapter.

- **Settings** are per profile (`GET/PUT /profiles/:id/learning`), default off:
  `enabled`, `correctionEnabled`, `reviewEnabled`, `extractionEnabled`,
  `periodicReviewMinutes` (0..10080), `maxRunsPerDay` (1..20, default 20),
  `maxTokensPerDay` (6000..200000, default 200000),
  `consolidationInputChars` (4000..40000, default 12000; a consolidation reserves that plus 6000 tokens),
  and `triggerPhrases` `{correction,preference,temporary,ignore}` (each at most 50
  plain phrases of up to 80 characters, no control characters). Saving never runs a job.
- **Models** are the auxiliary purposes `memory-correction`, `memory-review`
  and `memory-extraction` under Settings → Preferences → Auxiliary models. A
  blank purpose is `waiting-config`; the chat model is never substituted.
- **Triggers** (a job waits only for its own source session and the maintenance
  lock; while that session is busy it is retried every second, not left for the
  periodic tick): a settled turn, a successful compaction and worker exit/quit
  register verified native user/assistant pair references (no transcript body
  is stored). Explicit corrections and "remember from now on" preferences are
  handled first by the correction purpose; ordinary pairs go to review;
  `server/profile-memory/learning-triggers.js` recognises Chinese and English
  phrasing built in (English follows upstream's strong/weak/negative correction
  patterns) and adds the profile's `triggerPhrases` as case-insensitive plain
  substrings; `ignore` suppresses a correction or preference match, `temporary`
  keeps a turn out of learning, and questions or quoted examples never count;
  compaction/exit boundaries go to extraction of pairs not yet covered.
  Positive `periodicReviewMinutes` throttles review and lets a periodic scan
  backfill known sessions. Learning reads native sessions up to the 64 MiB
  source-proof bound (`capabilities.maxSourceBytes`), so a long-running single
  thread keeps being learned from; larger sessions are skipped. The derived
  search index keeps its own 8 MiB bound.
  Pairs before the last `pivane-learning-baseline` custom entry on the branch
  (written when older conversations are imported) are never learned from, in
  any kind or at a boundary; forks keep the baseline.
- **Writes** go only through `mutateFromNative` with the verified user entry
  as source, so they carry receipts, CAS, tombstones and the source-proof
  checks above. A correction may CAS-replace one matching old record;
  otherwise it creates a new record. A reusable procedure can only become a
  `draft` profile skill that the user must enable.
- **Bounds**: UTC daily reservation of 6000 tokens per attempt, at most 2
  concurrent runs globally and 1 per profile, a ~2400 character excerpt,
  prompt plus excerpt ≤ 5000 UTF-8 bytes, ≤ 320 output tokens, no tools, no
  CLI/subagent fallback, 20 s abort followed by waiting for real settlement.
  Queue 64 jobs, 128 cursors; deep branch rewrites block a cursor and are
  reported in `capabilities.capacity.blockedBranches`. Manual action IDs
  (`review-now`, `cancel`) are valid for 7 days; at most 256 active and 1024
  retired IDs are kept, after which actions fail explicitly.
- **Outcomes**: jobs report status, reason, model, receipt IDs and only the
  usage/cost the provider reported (`unknown` is not zero). Jobs running at a
  restart become `uncertain` and are never replayed. Deterministic trusted-write
  refusals (including the 413 source-proof limit) are `skipped/knowledge-rejected`;
  a learned entry refused by the content scan is `skipped/content-blocked`.

Each eligible `before_agent_start` re-reads profile and physical-cwd memory
from disk and appends a native `pivane-profile-memory-read` entry, which also
records `chars` (the injected block length) and `entries` (rendered MEMORY/USER
plus project entries).
`get_runtime_configuration.memoryRead` reports that last recorded read; it is
evidence of what was provided, not that the model followed it. This is not a
mastery/progress inference engine, and provider cancellation behaviour must
still be verified for each real provider before activation.

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
parent gate.
`test/browser/pi-memory-learning-e2e.cjs` (requires `PIVANE_TEST_HERMES_BUNDLE`)
runs the whole loop against the real assembled gateway, real Pi RPC workers and
a loopback synthetic provider in a throwaway identity: dedicated learning
models, an explicit Chinese preference learned in a real chat turn, the chat
card receipt, injection into the next turn, an agent `memory_add` through the
journal, `skill_manage view`, edit and undo in the management page, exit
extraction without re-learning, and the 393 px layout. Keep the prefix and record its bundle, lock and native hashes.
Before enabling a real profile, finish active work and back up
`<agentDir>/pivane-profiles/` and configuration. Parent activates only reviewed
new workers under its maintenance flow. Rollback removes the hook/env/router
and keeps profile data and native sessions. This lane has not deployed or
published the adapter. Node 22 ARM64, macOS and Windows native ABI remain
separate platform verification gates; the evidence here is Node 24 Linux ARM64.
