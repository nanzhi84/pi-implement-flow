# pi-implement-flow

A pi extension implementing Spec [#1](https://github.com/nanzhi84/pi-implement-flow/issues/1).

**Work in progress:** T1 (#2) validates read-only planning and refusal paths.
It never dispatches work or merges PRs. No Ticket is considered delivered yet.

## Develop

Requires Node.js 24+, npm, Git, authenticated `gh`, and pi 0.87.1.

```sh
npm ci
npm run typecheck
npm test
pi --no-extensions -e ./src/extension.ts
```

Inside pi, use `/flow start <issue-number> [--concurrency N]` or `/flow status`.
See [execution contract and current limitations](docs/execution-contract.md).

## Acceptance

Tests drive the real pi RPC command/UI boundary in temporary Git projects with
isolated pi resource directories. No model invocation is needed. They never send
`/flow` unless the real extension command is registered. They do not mock pi.

```sh
# Local refusal paths; GitHub scenarios are explicitly skipped.
npm test
# Also check actual native GitHub planning and readable rules.
RUN_GITHUB_E2E=1 npm test
```

The remote cases read public repository `nanzhi84/pi-implement-flow-acceptance`:

| Spec | Planning fixture | Expected result |
| --- | --- | --- |
| #1 | Native child #2, no dependencies | Plan read; readable rules still do not permit incomplete startup |
| #3 | Missing acceptance agreement | Actionable refusal naming #3 |
| #4 | Native children #5/#6, textual cycle | Cycle diagnostic `#5 -> #6 -> #5` |
| #7 | Native child #8 depends on outside child #2 | Invalid-dependency diagnostic |
| #9 | Native children #10/#11, native dependency #11 → #10 | Show native edge and requested concurrency 3 |
| #12 | Qualified shorthand `other/repo#13` | Reject, never silently map to local #13 |
| #15 | Mixed valid reference and `#0` | Reject, never drop invalid reference |
| #18 | `None pending clarification` | Reject ambiguous declaration |
| #20 | Planning headings inside a fenced example with a false closing marker | Example cannot satisfy real acceptance |
| #21 | Nonbreaking space after a would-be closing fence | Unicode suffix must not turn example headings into real planning |

The repository was made public with user approval. Historical evidence release
`acceptance-32e3acf` describes its former private-plan rejection, **not** the
current environment. Assets remain unchanged; it is not current-version evidence.
These are still preflight/refusal fixtures, not proof of successful startup.
Tests only read GitHub; they create no Issues, PRs or branches.

`artifacts/preflight.json` records the source SHA, dirty status, runtime versions,
assertions and test boundary. Only `dirty: false` evidence can identify an exact
committed version. Artifacts intentionally exclude raw process output and local
paths. Preserve published evidence; temporary local test resources are cleaned.

The acceptance runner also includes teardown in its final verdict. To verify that
infrastructure/cleanup failures cannot produce passing evidence (both commands
must exit nonzero, with `allSelectedScenariosPassed: false`):

```sh
PI_BIN=/nonexistent/pi npm test
FLOW_ACCEPTANCE_FAIL_CLEANUP=1 npm test
```

Failure modes selected before implementation: missing/malformed execution
contract, unreadable GitHub protection, missing planning criteria, dependency
cycles, out-of-Spec dependencies, native-only dependencies and accidental
mutation/dispatch. Full start, dependency scheduling, recovery and merge acceptance
remain unverified and are not implied by passing these tests.
