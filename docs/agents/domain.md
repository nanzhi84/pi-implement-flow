# Domain docs

## Layout

This is a single-context repository:

- `CONTEXT.md`: domain vocabulary and context.
- `docs/adr/`: architecture decision records.

## Before exploring

Read root `CONTEXT.md` and ADRs relevant to the area being explored.

If `CONTEXT-MAP.md` is introduced later, follow its pointers to relevant
context documents and check context-scoped ADRs too.

If these documents do not exist, proceed silently. Do not flag their
absence or suggest creating them upfront. The domain-modeling skill
creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts.
Avoid synonyms the glossary explicitly rejects.

If a concept is missing, reconsider whether it belongs, or note a real
gap for domain-modeling.

## Flag ADR conflicts

Explicitly surface proposals that contradict existing ADRs rather than
silently overriding them. Identify the ADR and explain why reopening
the decision may be worthwhile.
