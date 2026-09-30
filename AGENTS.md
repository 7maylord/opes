# AGENTS.md — Codex project instructions

These rules apply to Codex for every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

## Rule 1 — Think Before Coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

## Rule 2 — Simplicity First

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

## Rule 3 — Surgical Changes

Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

## Rule 4 — Goal-Driven Execution

Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

## Rule 5 — Use the model only for judgment calls

Use model reasoning for: classification, drafting, summarization, extraction.
Use code for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory

Per-task: 4,000 tokens. Per-session: 30,000 tokens.
Track usage when token accounting is available; otherwise use estimates and
state that exact usage is unavailable. These are working limits, not limits
enforced by this file.
If approaching a limit, summarize progress and remaining work, and ask the user
to start a fresh session. Do not claim to have started a session yourself.
Surface any known or estimated breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write

Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior

Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree

Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

## Git commit messages

**Never add AI co-author trailers or any Codex/AI attribution** to commit
messages, PR bodies, or commit commands handed over for the user to run.
Drop it silently — do not ask, do not mention it.

**Subject line only.** A commit message is one Conventional Commits line and
nothing else: `feat: implement recursive upstream lineage tracer`. No body, no
bullet points, no explanatory paragraphs. Lowercase imperative after the prefix.

Keep the log clean and scannable, reading as the author's own work.

**Prefer several small, concern-scoped commits** over one large one. Group by
subsystem so no file has to be split across commits, and order them so the tree
still builds at the end of the sequence.

To strip a trailer or body from commits already written:
`git rebase <base> --exec 'git commit --amend -m "$(git log -1 --format=%s)"'`

When dispatching subagents that commit their own work, repeat the no-attribution
and subject-line-only rules in the dispatch prompt.

## Who runs git

Codex may run `git add` and `git commit`.

**Never run `git push`.** Pushing is the user's call alone — no `git push`, no
`--force`, no pushing a branch "so it's ready". Commit the work, then stop and
say which commits are ready for the user to push.

Never rewrite history that has already been pushed. Rewriting local, unpushed
commits is fine (that is how a bad message gets fixed).
