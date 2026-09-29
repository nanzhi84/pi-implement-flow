# pi-implement-flow

A pi extension implementing Spec [#1](https://github.com/nanzhi84/pi-implement-flow/issues/1).

**Work in progress:** only the first read-only refusal slice of T1 (#2) exists.
It never dispatches work or merges PRs. No Ticket is considered delivered yet.

## Develop

Requires Node.js 24+, npm, Git, authenticated `gh`, and pi 0.87.1.

```sh
npm ci
npm run typecheck
npm test
pi --no-extensions -e ./src/extension.ts
```

Inside pi, use `/flow start <issue-number>` or `/flow status`.
See [execution contract and current limitations](docs/execution-contract.md).

## Acceptance

Tests drive the real pi RPC command/UI boundary in temporary Git projects with
isolated pi resource directories. No model invocation is needed. They never send
`/flow` unless the real extension command is registered. They do not mock pi.

```sh
# Local refusal paths; the GitHub case is explicitly skipped.
npm test
# Also check the actual private fixture's unreadable protection rules.
RUN_GITHUB_E2E=1 npm test
```

The remote case requires read access to private repository
`nanzhi84/pi-implement-flow-acceptance`, native child #2 of Spec #1, and a GitHub
plan that returns an error for private repository rule inspection. This is a
**negative-path fixture**, not portable proof of successful startup. If the
repository plan changes, update the acceptance scenario rather than weaken the
gate. Tests only read GitHub; they create no Issues, PRs or branches.

`artifacts/preflight.json` records the source SHA, dirty status, runtime versions,
assertions and test boundary. Only `dirty: false` evidence can identify an exact
committed version. Artifacts intentionally exclude raw process output and local
paths. Preserve published evidence; temporary local test resources are cleaned.

Failure modes selected before implementation: missing/malformed execution
contract, unreadable GitHub protection, and accidental mutation/dispatch on these
refusal paths. Full start, dependency scheduling, recovery and merge acceptance
remain unverified and are not implied by passing these tests.
