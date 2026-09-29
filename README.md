# pi-implement-flow

A pi extension implementing [Spec #1](https://github.com/nanzhi84/pi-implement-flow/issues/1).

**Current slice: T2 single-Ticket implementation.** `/flow start` confirms the
planned scope, executes real isolated probes and runs an implementation Agent in
its own worktree. It commits/pushes the result and creates a Draft Ticket PR into
the feature branch, then pauses at `gates-not-installed`. The Ticket stays open;
T3 and later provide gates, integration, parallel scheduling and final delivery.
`/flow preflight` runs only the original preflight/probe path.

## Develop and use

Requires macOS/Linux, Node.js 24+, npm, Git, authenticated `gh` and pi 0.87.1.

```sh
npm ci
npm run typecheck
npm test
pi --no-extensions -e ./src/extension.ts
```

In pi: `/flow start <issue-number> [--concurrency N]`, `/flow preflight <issue-number>`, or `/flow status`.
The target project must already be runnable, clean, at remote main, with a
committed `.pi/flow.json`; use the [execution contract](docs/execution-contract.md).
Commands require user confirmation and run with the user's OS permissions, not
in a security sandbox. Unsupported protection policies are rejected, not bypassed.

## Acceptance

```sh
# Local refusal paths; all GitHub/startup scenarios explicitly skipped.
npm test
# Real pi + GitHub, independent SDK context readiness and runnable project probes.
RUN_GITHUB_E2E=1 npm test
```

Remote tests use the public synthetic repository
`nanzhi84/pi-implement-flow-acceptance`. They require:

- Existing fixture Issues/native relations/ruleset, documented below.
- Its runnable greeting project on main, matching `tests/fixtures/project/`.
- A selected pi model with configured credentials, defaulting to the host
  `PI_PROVIDER`/`PI_MODEL` (otherwise openai-codex/gpt-6-astra).
- Source auth/model files in `FLOW_TEST_AGENT_DIR`, `PI_CODING_AGENT_DIR`, or
  `~/.pi/agent`. Only those explicit files are symlinked into temporary test-agent
  directories; no settings/extensions/skills/instructions are inherited or copied
  into artifacts. Credential readiness checks may refresh auth, but these preflight tests
  do not send model prompts.
- Permission to publish synthetic, content-addressed Release assets. Unknown
  publisher results stop and reconcile exact remote identities; no blind retries.

If the existing proxy drops GitHub HTTP/2 connections (EOF/TLS transport errors),
a per-process HTTP/1.1 compatibility run is supported and recorded in evidence:

```sh
GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version \
GIT_CONFIG_VALUE_0=HTTP/1.1 RUN_GITHUB_E2E=1 npm test
```

This changes no global settings, disables no TLS verification, adds no retries
and does not weaken assertions. Diagnose failures first; never count an
infrastructure-failed suite as accepted.

The suite drives real pi RPC, not a mocked ExtensionAPI. Git repositories, pi
resource directories and test data are temporary and isolated. The lifecycle
bridge only exposes actual pi `newSession/fork/navigateTree/reload` operations
not otherwise available as built-in RPC slash commands; it does not fake events.
Test processes run serially except deliberate competing-controller scenarios.

### Planning fixtures

| Spec | Fixture | Expected result |
| --- | --- | --- |
| #1 | Native child #2 | Read structure; unprepared clone refuses, prepared project starts safely paused |
| #3 | Missing acceptance | Actionable refusal |
| #4 | Children #5/#6 with textual cycle | `#5 -> #6 -> #5` |
| #7 | Child #8 depends on outside child #2 | Invalid dependency |
| #9 | Native dependency #11 → #10 | Native edge and requested concurrency 3 |
| #12 | `other/repo#13` | Refuse qualified shorthand |
| #15 | Mixed valid ref and `#0` | Refuse, never drop invalid ref |
| #18 | `None pending clarification` | Refuse ambiguous declaration |
| #20/#21 | False closing fences, including NBSP | Examples cannot supply real planning |
| #22 | Required-review ruleset on `flow/spec-22` | Refuse unsupported native approval without admin bypass |

Startup additionally validates real greeting assertions, preparation failure,
remote artifact bytes/version, independent-role auth refusal, cross-clone
controller exclusion, contract edits during confirmation, session replacement,
fork/tree/reload and rejection of late approval. Clean probe HEAD drift is also
rejected and preserved. Cleanup/publish quiescence cases drive real commands but
inject the `process.kill(..., 0)` liveness observation at the OS boundary after the
actual child exits. They prove conservative ownership retention on uncertainty,
not that this machine produced a genuinely unkillable kernel process. Test-only
stale socket cleanup occurs only after the owned pi process exits and `lsof`
confirms no live owner (these two fault cases require `lsof`).

### Evidence

`artifacts/preflight.json` includes source SHA/dirty status, prerequisites,
runtime versions, assertions and the **final** runner exit (including teardown).
Only clean-SHA evidence can identify a committed version. Project probe assets
bind the tested fixture SHA and approved scope/contract digests; the outer suite
binds the extension SHA. Neither substitutes for the other.

```sh
# Controlled harness failures: nonzero exit and failing evidence are required.
PI_BIN=/nonexistent/pi npm test
FLOW_ACCEPTANCE_FAIL_CLEANUP=1 npm test
```

The repository was made public with user approval. Historical releases such as
`acceptance-32e3acf` describe old code/environment and never release new versions.
A deliberate red test at 55d6ccc reproduced invalid old-SHA publication. That
negative-test Release is explicitly marked INVALID and retained; protocol-v2
reports and new clean-SHA suite evidence supersede it, never reuse it for release.
Preserve remote evidence at least 90 days and while related review remains open.
Do not publish raw logs, credentials, private paths or production data.

## Ticket execution acceptance

```sh
RUN_GITHUB_E2E=1 npm run test:execution
RUN_GITHUB_E2E=1 npm run test:ticket-faults
```

This creates new synthetic Spec/native Ticket fixtures in the acceptance repository.
Real model scenarios verify the delivered PR's actual greeting CLI and the no-PR
ambiguity path. Deterministic loopback-model scenarios verify no-difference and
cancelled/late-result boundaries through real pi and SDK calls. See
[scenario contract](docs/testing/t2-scenarios.md) and `artifacts/execution.json` for
selected coverage, source version, assertions and retained remote links. Failed
workspaces are preserved; the private `*.local.json` locator must not be published.
Use the documented HTTP/1.1 environment above if the proxy drops HTTP/2 requests.
The fault suite additionally verifies Ticket prepare/cleanup source drift and a
successful remote push whose CLI response is lost; it uses explicitly loaded
test process wrappers and a fixed loopback model, not real-model quality evidence.
The npm scripts select the repository's locked pi version; a direct `node` command
may resolve a different globally installed pi, which is recorded separately.

Role tools are restricted to their worktree; `bash` accepts only approved command
names `prepare`, `check`, `accept`. Agents cannot use the supported tools to commit,
push, invoke GitHub or access another worktree. Trusted project commands remain
ordinary OS processes, so this is not a credential sandbox. The controller prepares
and cleans each Ticket's resource directory and checks actual branch/HEAD, contract
and instructions before delivery. Unknown remote writes or unverified stopping
retain ownership and require reconciliation; this slice does not auto-resume them.

## Development delivery

The user authorized this repository's Ticket PRs to merge directly to main only
after per-Ticket acceptance and independent review. This development workflow
**does not change the product invariant**: a running flow must never merge its
customer project's total PR into main. The originating decisions remain on #1.
