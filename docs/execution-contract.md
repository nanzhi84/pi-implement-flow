# Execution contract — T1 partial implementation

**This version cannot start or dispatch a flow.** `/flow start <issue-number>`
reads a local contract, the origin repository's Spec and native direct children,
then attempts to read active feature-branch rules. Inaccessible rules fail closed.
Even when rules are readable it returns `PREFLIGHT_INCOMPLETE`. `PLAN_READ` is not
plan approval or evidence that dependencies, permissions, or commands are valid.

## Responsibilities and trust

- `src/extension.ts`: real pi command and sanitized diagnostics; no model tool.
- `src/contract.ts`: local JSON boundary and explicitly selected child resources.
- `src/github.ts`: read-only GitHub REST through authenticated `gh`; 30-second
  call timeout, bounded response size, no added retries or remote writes.
- No persistent execution ledger, worktrees, child agents, or merge operation.
- This is process policy, not OS/credential isolation. Child configuration is
  parsed but there are no child agents yet. External Issue text cannot grant tools.

Only credential-free `https://github.com/owner/repo[.git]` and
`git@github.com:owner/repo[.git]` origins are supported. Errors deliberately omit
subprocess output, credentials, Issue bodies and local paths.

## `.pi/flow.json`

See `tests/fixtures/flow.json` for the current **schema example, not a runnable
project contract**. That file deliberately references a nonexistent `fixture.mjs`:
these early tests only reach read-only rejection paths, and do not certify a
prepared execution environment.

Required fields (unknown keys are rejected):

- `version`: `1`.
- `commands`: nonempty argv arrays for `prepare`, `cleanup`, `check`, `accept`,
  `publish`. No shell interpolation is implied. Command existence, successful
  execution and publishing are **not yet verified**.
- `commandTimeoutMs`: positive safe integer; per command, not an Agent/flow budget.
- `resources`: `mode` (`isolated` or `exclusive`) and a description. Resource
  allocation and exclusivity are not implemented yet.
- `artifacts`: destination description and positive retention days. Publication
  and retention guarantees are not verified yet.
- `agents.implementation`: explicit `tools`, empty `extensions`, explicit
  project-relative `instructions` files, which must resolve inside the project.
- `agents.review`: same fields, only read-only built-in tools, and
  `isolation: "independent-context"`.
- `agents.retry`: boolean `enabled`, nonnegative `maxRetries`, and
  `providerMaxRetries: 0` to avoid stacked provider retries. These are underlying
  transport settings, not limits on implementation repair rounds.

## Remaining T1 acceptance (do not close #2)

Dependency and acceptance-content validation; complete plan/range confirmation;
configurable concurrency; local repository singleton control; separate internal
review readiness and GitHub-native review/permissions checks (including classic
protection); isolated project preparation/cleanup/check/accept/publish probes;
safe start and lifecycle pause; successful real pi/GitHub acceptance.

No existing native review requirements may be bypassed. A private repository's
GitHub plan error is not treated as an empty protection policy.
