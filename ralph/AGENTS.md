# Subagent Reference

The loop's iterations launch subagents for research, planning, architecture advice and review, so the
iteration's own context stays small. This file says which to use and at what size.

## The smallest-model rule

Start with the smallest model that can do the job; escalate on purpose. Every Agent launch names its
`model` (`haiku | sonnet | opus`, the aliases in `ralph.config.json` `models`). The
`scripts/hooks/require-agent-model.cjs` PreToolUse hook blocks a launch with no `model`, unless
it is a fork or a project agent (`.claude/agents/<name>.md`) whose front matter pins a model other than
`inherit`. `.claude/settings.json` sets `CLAUDE_CODE_SUBAGENT_MODEL` as a fallback for launches the hook
does not see.

| Work | Model |
|------|-------|
| Find or list files, simple greps, run a command and report pass/fail, docs lookups | `haiku` |
| Read and reason over code, research, diagnose failing tests, build a patch, apply a known change | `sonnet` |
| New design with open trade-offs, root-causing a subtle bug, security review, final review | `opus` (state why) |

## Agents

### Explore (research)
Read-only broad search: "where is X handled", "what patterns exist for Y", "who calls Z". Ask for a
file list with `file:line` and one-line purposes, not file contents. Use `haiku` for lookups, `sonnet`
when the answer needs reasoning across files. Launch several in one response for independent questions.
Used by: plan (gap analysis), build (finding where code lives), design (research), feature-dev.

### Plan (planning)
Designs an implementation approach and lists critical files and trade-offs for a hard task. `sonnet`;
`opus` only for open security or design risk. Used by: plan mode on large or ambiguous specs.

### architecture (architecture guardian, project-defined)
Checks placement, layering, dependency direction and consistency with `standards/`. Define it as
`.claude/agents/architecture.md` with a pinned model if your project wants one; the kit does not ship
a domain-specific version. Used by: design (validate approach), build (unsure where code belongs).

### code-review (`.claude/agents/code-review.md`)
Generic reviewer. Reads `standards/` and the diff, returns findings with severity, scope bucket and
`file:line`. Model pinned in its front matter to the review alias (`opus`). Tools: Read, Grep, Glob,
Bash. It reports; it does not edit. Used by: the build Exit Gate (once per spec), review mode (once per
spec state). Never per phase. Configured by `gates.reviewSubagent`.

### general-purpose / mechanical
For bulk mechanical edits (rename across many files, regenerate a manifest). `haiku`, with an exact
instruction and a command that verifies the result.

## How to brief a subagent

- State the question, the scope (paths), and the output shape (list of `file:line`, max N items).
- Give it the standards file names that apply; do not paste them.
- Ask for conclusions and file lists, then read the few files that matter yourself.
- Independent launches go in one response. Dependent ones wait.
- A subagent result is evidence, not authority: verify any claim you will build on by reading the code.
- Subagents never decide product questions, sign approvals, or run destructive commands.
