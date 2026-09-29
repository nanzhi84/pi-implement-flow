# pi-implement-flow

A pi extension implementing [Spec #1](https://github.com/nanzhi84/pi-implement-flow/issues/1).

**Current slice: T1 preflight/startup.** It reads and confirms planned Tickets,
checks environment and role readiness, executes real isolated project probes,
publishes/verifies evidence, then starts in `paused (executor-not-installed)`.
T2 and later Tickets provide implementation, gates, scheduling and delivery.
Preflight success is not a completed Ticket or completed Spec.

## Develop and use

Requires macOS/Linux, Node.js 24+, npm, Git, authenticated `gh` and pi 0.87.1.

```sh
npm ci
npm run typecheck
npm test
pi --no-extensions -e ./src/extension.ts
```

In pi: `/flow start <issue-number> [--concurrency N]` or `/flow status`.
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
  into artifacts. Credential readiness checks may refresh auth, but these T1 tests
  do not send model prompts.
- Permission to publish synthetic, content-addressed Release assets. Unknown
  publisher results stop and reconcile exact remote identities; no blind retries.

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
fork/tree/reload and rejection of late approval.

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
Preserve remote evidence at least 90 days and while related review remains open.
Do not publish raw logs, credentials, private paths or production data.

## Development delivery

The user authorized this repository's Ticket PRs to merge directly to main only
after per-Ticket acceptance and independent review. This development workflow
**does not change the product invariant**: a running flow must never merge its
customer project's total PR into main. The originating decisions remain on #1.
