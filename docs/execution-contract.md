# Execution contract

`/flow start <issue-number> [--concurrency N]` defaults to concurrency 2. T1
validates and confirms the exact plan, checks supported permissions/protection
and independent-role readiness, executes real project probes, downloads the
published evidence, then starts a flow **paused with `executor-not-installed`**.
Ticket implementation arrives in T2; successful preflight is not Ticket delivery.

## Preconditions and trust

- macOS/Linux, Node 24+, pi 0.87.1, Git and authenticated `gh`.
- Invoke from a clean repository root whose committed HEAD equals remote main.
  Uncommitted/unpushed work is refused, never discarded. Existing feature branches
  or unresolved probe workspaces require reconciliation rather than a fresh start.
- Origin is a credential-free github.com HTTPS/SSH URL. Canonical repository ID
  keys a `/tmp/pi-flow-<uid>-<hash>.sock` lock across clones/worktrees. A stale
  socket is never stolen. Ownership is local to the same OS account, not distributed.
- The selected pi model and saved credentials must be available to the explicit
  SDK role runtime. Role setup creates independent conversations, not model calls.
- Project commands are trusted code approved by the user. Worktrees and process
  groups are **not an OS/credential sandbox**. Commands must not daemonize, escape
  their process group, mutate project code, or write outside assigned resources.
- Same-repository GitHub Release assets are the currently supported publisher
  contract. No secrets, production data or raw process output belong in evidence.

## Data and module boundaries

- `extension.ts`: pi command and lifecycle adapters.
- `preflight.ts`: in-memory control, exact approval digest and revalidation.
- `plan.ts`: structural acceptance/dependency validation, not semantic inference.
- `github.ts`: authenticated read-only native planning and policy inspection.
- `contract.ts`, `agents.ts`: explicit role resources, authentication and SDK setup;
  discovered extensions, skills, prompts, themes and global instructions excluded.
- `control.ts`: ephemeral kernel ownership; no execution/attempt ledger.
- `workspace.ts`, `process.ts`, `probe.ts`: isolated commands, cancellation,
  assertion/evidence boundaries and byte-for-byte remote verification.

## `.pi/flow.json`

The runnable example is `tests/fixtures/project/.pi/flow.json`. The older
`tests/fixtures/flow.json` is only a schema fixture used by refusal tests.
Unknown configuration keys are rejected; required fields:

- `version: 1`.
- `commands`: nonempty argv arrays for `prepare`, `cleanup`, `check`, `accept`,
  `publish`. No shell interpolation by the orchestrator. Use explicit executables.
- `commandTimeoutMs`: integer 1..2147483647, applied per command, not to an Agent
  or the whole flow. Output is bounded to 4 MiB; stderr is not published.
- `resources`: `mode` (`isolated` or `exclusive`) and a description. Preflight
  always runs one probe at a time in its owned worktree/resource directory.
- `artifacts`: destination description and positive `retentionDays`.
- `agents.implementation`: explicit built-in `tools`, empty `extensions`, and
  project-relative `instructions` files resolving inside the project.
- `agents.review`: read-only built-in tools, empty extensions, explicit instruction
  files and `isolation: "independent-context"`.
- `agents.retry`: boolean `enabled`, nonnegative finite `maxRetries`, and
  `providerMaxRetries: 0`. These are SDK transport retries, not repair budgets.

## Command and artifact protocol

All commands run in a detached worktree of the confirmed SHA. Environment:

- `FLOW_RESOURCE_DIR`: unique owned resource directory; write test data here.
- `FLOW_CODE_SHA`: tested Git commit.
- `FLOW_REPOSITORY`: canonical owner/repository.
- `FLOW_REPORT`: orchestrator-produced report for publication.

Order: prepare → check → accept → cleanup → publish. Cleanup runs after failed
preparation/check/acceptance too, unless process quiescence or code preservation
cannot be established. Both HEAD SHA and worktree contents must remain unchanged after each command
and before removal; a clean commit/checkout is still version drift. Dirty or
unresolved workspaces are preserved; no force removal. Probe-only directories are
removed only after safe project cleanup. Publisher failures preserve the report. An unverified process-stop classification
is preserved across cleanup/publish/Git error boundaries and retains controller
ownership; it cannot become an ordinary publisher/cleanup failure.

`accept` must exit zero and emit only JSON:

```json
{"passed":true,"assertions":[{"name":"greeting-for-name","passed":true}]}
```

Assertion names are nonempty lowercase `[a-z0-9._-]`, at most 80 characters.
Assertions must be nonempty and all passed. A text success claim is insufficient.
Project command correctness itself remains subject to independent code review.

The orchestrator writes a sanitized protocol-v2 report (generator
`pi-implement-flow/probe-v2-head-checked`) binding code SHA, approved scope and
contract digests, runtime, command phases, assertions, cleanup result and retention.
`publish` reads `FLOW_REPORT`, preserves its exact bytes, and emits:

```json
{"url":"https://github.com/owner/repo/releases/download/tag/preflight.json","sha256":"<64 hex digits>","retentionDays":90}
```

The URL must be a same-repository Release asset; its SHA256 and retention must
match the contract. The orchestrator downloads it through authenticated `gh` and
checks bytes before startup. Publishers own idempotent content-addressed remote
identity and unknown-result reconciliation; the orchestrator never blindly
replays a failed publisher. The fixture publisher demonstrates this contract.

## Confirmation, policy and lifecycle

Before execution the user sees the complete Spec/Tickets, dependencies, selected
model, contract, instructions, baseline and concurrency. Their exact snapshot is
hashed and re-read after confirmation and after probes. Changed contents, local
work, main baseline or policy cannot reuse old approval/evidence.

Internal role readiness is separate from GitHub approval. Effective push access,
Issues and main are required. Active feature-branch pull-request rules return
`NATIVE_REVIEW_UNAVAILABLE`; other active rules/classic protection return
`PROTECTION_UNSUPPORTED` until their complete conditions/identities are supported.
Classic wildcard rules are conservatively rejected even when a target does not
yet exist. Inaccessible policy is never treated as absent; admin bypass is never
used. This initial supported subset must not be mistaken for all GitHub policies.

Session switch/fork/tree/reload/shutdown abort pending confirmation/work, wait
for safe stopping, and release ownership only when quiescence is known. Late
confirmations cannot start a flow. No chat/session operation rolls back Git or
GitHub. A successfully preflighted flow retains ownership while intentionally
paused awaiting T2; session change/shutdown releases it safely.

## Planning format

A Spec has `## Problem Statement` and bullet/numbered `## Acceptance criteria`
(or `## Testing Decisions`). Tickets have `## What to build` and `## Acceptance
criteria`. Missing/duplicate sections fail closed; code examples cannot supply
real planning. This checks structure, not natural-language semantic completeness.

Tickets are native direct children in the same repository. Native blocked-by
edges are paginated. Without native edges, `## Blocked by` explicitly declares
`None` or same-repository `#number`/HTTPS Issue URLs. Both representations must
agree when present. Whole tokens are consumed; qualified shorthand, invalid
numbers, ambiguous prose, mixed None/references and Markdown links are refused.
Trailing parenthetical display notes cannot conceal references/URLs. Out-of-Spec
edges and cycles name the relevant Issues. Closed is never equivalent to merged.
