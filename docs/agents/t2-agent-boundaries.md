# T2 implementation Agent boundary

## Design and observable failures (before implementation)

The controller owns Git, GitHub and delivery decisions. An implementation Agent
receives an independent, in-memory pi SDK conversation with explicit approved
instructions, Ticket context and tools. Its return value is a proposal, never
acceptance evidence. No flow, attempt or Agent transcript ledger is added.

The following failures must stop delivery and preserve the worktree:

- Missing model/authentication, provider failure, cancellation, truncated output,
  malformed JSON or a final response outside the explicit result union.
- A command/process whose termination cannot be established. This remains
  `PROCESS_UNQUIESCED`; it is never converted into model success or ordinary retry.
- A question about requirements. The model must return `blocked` before its first
  edit; the controller records the question and verifies actual Git changes.
- Late model output after cancellation. The controller must never publish it.

A path outside the assigned real directory, `.git`, symlink, non-regular file or
unsupported shell command is refused at that tool call. The model may correct its
request within scope; a refused call alone does not terminate a Ticket. Unknown
process quiescence is fatal and cannot be recovered by another model tool call.

The supported tools are confined read/edit/write/grep/find/ls and `bash` whose
`command` is exactly `prepare`, `check`, or `accept`. That tool maps directly to
the already approved argv; it never evaluates an Agent-provided shell string.
Read and write paths are checked both at entry and at the filesystem operation.
Searches exclude symlinks and `.git`; directory traversal and output are bounded.
The Agent cannot directly commit, push, invoke `gh`, merge, or change branches.

Project commands remain trusted code and can execute code the Agent has edited.
These restrictions describe supported workflow tools, not an OS/credential
sandbox: same-user concurrent filesystem replacement and trusted project command
behavior are outside this boundary. Commands must obey the approved worktree and
resource contract. Actual Git branch, baseline and dirty-tree checks remain the
controller's responsibility before and after Agent execution.

Cancellation requests `session.abort()`, waits for SDK idle and in-flight custom
tools to settle, and only then disposes the session. Child processes use the
existing bounded, process-group-scoped command runner. Model error text, raw
transcripts and command output are not published as acceptance artifacts.

## Verification responsibilities

Use the real `/flow` pi RPC path with synthetic repositories and a configured
model: implement a small visible behavior, inspect its remote Ticket PR and base,
and run the project's behavior acceptance separately. Controllable model fixtures
may exercise rejected tool calls, blocked-before-edit and cancellation, but must
be labeled as protocol fault injection and cannot replace the live model path.
Repeatable artifacts must report the command, prerequisites and observed outcomes;
successful model completion alone must never appear as a passed delivery gate.
