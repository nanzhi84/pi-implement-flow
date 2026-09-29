# T2 project-command and remote-write fault acceptance

## Failures and assertions defined before implementation

The suite exercises real pi RPC `/flow start`, SDK role setup, Git worktrees and
GitHub in `nanzhi84/pi-implement-flow-acceptance`. It creates new synthetic Spec
and native Ticket Issues. It never edits the existing fixture, its main branch,
or production source to produce a failure. A loopback model gives deterministic
JSON when the model is supposed to run; this proves control behavior, not model
implementation quality.

1. **Ticket prepare source drift**: an explicitly loaded test bridge wraps only
   the real prepare CLI inside a Ticket worktree. After the real command succeeds,
   it appends a harmless synthetic comment to `app.mjs`. Preflight prepare remains
   unchanged. Assert `WORKSPACE_DRIFT`, zero model HTTP requests, retained changed
   worktree at its original baseline/branch, no Ticket push/PR, open Issues and
   unchanged original checkout and remote main.
2. **Ticket cleanup source drift**: the bridge wraps only Ticket cleanup, lets it
   actually release fixture data, then appends a synthetic source comment. Assert
   the real SDK requested and received the fixed model result, cleanup drift is
   refused, changed worktree remains available, no Ticket push/PR, open Issues and
   unchanged main. A command exit code of zero is insufficient to authorize push.
3. **Feature push accepted but client reports failure**: the bridge starts real
   `git push` for the newly selected feature branch; only after Git exits zero
   does its wrapper exit one. Assert the remote branch exists at the expected
   SHA, exactly one push attempt and one observed successful remote write,
   `REMOTE_RESULT_UNKNOWN`, no model dispatch/Ticket PR, and retained controller
   ownership. A real pi `new_session` must emit `FLOW_STOPPING`; another clone
   must receive `FLOW_OWNED`. Neither controller may replay the write.

Only process/CLI boundaries are injected. No FlowController, remote API, Git
result reader, SDK session or production source is mocked. Every injected command
runs in the already owned process group. All injected writes are synthetic and
confined to that scenario's worktree. Dirty workspaces and local facts remain
after a passing fault test for manual inspection; the public report excludes
their private filesystem paths.

The test observer uses a process-local `globalThis` symbol because pi can rebuild
extension factories during `new_session`. The phase and counters survive only
within that same process. Each rebuilt factory reinstalls the same wrapper and
binds a fresh UI context; the underlying native spawn is captured once to avoid
recursive wrapping. This keeps any later push observable without a file ledger
or assumptions about production controller state surviving a process restart.

## Repeatability and evidence

Run only when no other acceptance flow owns this repository:

```sh
RUN_GITHUB_E2E=1 npm run test:ticket-faults
```

`FLOW_TICKET_FAULT_SCENARIO=prepare-drift|cleanup-drift|push-unknown` selects one
case. Node 24+, Git, a working pi CLI and authenticated `gh` with synthetic fixture
write permissions are required. No external model credentials are required.

The wrapper report records the actual pi CLI version and declared local SDK
version separately, starting/ending Git SHA and dirty state, final runner exit result, selected/skipped scenarios, remote
Issue links, verified baseline and feature SHA, model request count, command
injection counts and assertions. It writes `artifacts/ticket-faults.json` and a
timestamped copy; raw model messages, credentials, private paths and stderr are
excluded. Per-scenario data uses the `ticket-faults` evidence prefix and does not
overwrite the ordinary T2 acceptance report. Local preserved paths remain only
in `artifacts/ticket-faults-preserved.local.json` and must not be published.
The suite only passes when source starts and ends clean at the same SHA; changed
source invalidates the evidence even if all scenario assertions passed.

A retained unknown-write controller is shut down only after test assertions. Its
known test-owned stale socket is removed only after the real process exits and
`lsof` verifies no live owner; this is test teardown, never automatic flow
recovery or evidence that unknown writes are generally safe to replay.
