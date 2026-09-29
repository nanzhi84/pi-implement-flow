# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `nanzhi84/pi-implement-flow`.
Use the `gh` CLI from this clone; infer the repository from its remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
  Use a heredoc for multiline bodies.
- Read: `gh issue view <number> --comments`
  Fetch labels and structured fields with `--json` when needed.
- List: `gh issue list --state open --json number,title,body,labels,comments`
  Apply appropriate label and state filters.
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..." --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If enabled later, use equivalent `gh pr` operations for external PRs.
GitHub shares issue and PR numbers; resolve ambiguous references with
`gh pr view <number>`, falling back to `gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Child tickets: link as GitHub sub-issues. If unavailable, use a task
  list in the map and `Part of #<map>` in each child's body.
  Label children `wayfinder:<type>`: research, prototype, grilling, or task.
- Blocking: use native GitHub issue dependencies where available;
  otherwise record `Blocked by: #<number>` in the child's body.
  A child is unblocked when all blockers are closed.
- Frontier: choose the first open child in map order with no open
  blockers and no assignee.
- Claim: assign the ticket to the driving developer using
  `gh issue edit <number> --add-assignee @me` as the session's first write.
- Resolve: comment with the answer, close the child, and append a
  summary and link to the map's Decisions-so-far.
