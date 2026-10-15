# Standards

`standards/` is your project's rulebook, written down so that people **and** agents apply the same
rules. The kit reads it at four points:

| Consumer | How it uses the corpus |
|----------|------------------------|
| `/design` | Reads the rules that match the feature's surfaces before drafting, and adds the spec sections a rule requires |
| `ralph/PROMPT_plan.md` | Lists the applicable standards once in the plan's `## Standards` and turns required sections into tasks |
| `ralph/PROMPT_build.md` | Reads the plan's listed standards before writing code |
| `.claude/agents/code-review.md` and review mode | Applies each rule's **detection** to the diff and reports violations with severity and `file:line` |

A rule nobody can check is a wish. Write rules so a reviewer (or a grep) can tell pass from fail.

## Layout

Group by domain, one file per topic. Suggested starting set; keep only what your project needs:

```
standards/
  README.md                  this file
  shared/
    general-principles.md    naming, error style, secrets, logging
    testing.md               what must be tested, file conventions, mocking
  backend/                   API shape, data access, errors, caching, events, migrations
  frontend/                  components, state, accessibility, i18n, styling tokens
  security/                  authentication, authorization, input handling
  infrastructure/            who applies what, environments, state
  agentic/                   rules for features where an AI agent acts on a user's behalf
  example-rule.md            a template to copy
```

Name files after the subject, not the team. Keep each under about 300 lines; split when it grows. Link
between files instead of repeating a rule.

## Rule format

Each rule is a second-level heading with a stable id and these fields, in this order:

```markdown
## DATA-3: Parameterise every query

- **Severity:** critical | warning | info
- **Rule:** One or two imperative sentences stating what must (not) be done, and why.
- **Detection:** How a reviewer or script finds a violation: a grep pattern, a file glob plus what
  to look for, or a question to answer about the diff.
- **Example:**
  - Violation: `db.query("select * from t where id = " + id)`
  - Correct: `db.query("select * from t where id = $1", [id])`
```

- **Id**: `<AREA>-<n>`, unique across the corpus, never reused after a rule is retired (mark it
  `Retired` instead of deleting).
- **Severity**: `critical` blocks the build Exit Gate and a clean review; `warning` must be fixed when
  the finding is inside the spec's scope; `info` is advice.
- **Rule**: say what to do, then the reason in a clause. Avoid "should consider".
- **Detection**: be concrete. If a script can check it, name the script. A rule with no detection is
  incomplete.
- **Example**: always show one violation and its correction.

Optional fields: **Applies to** (globs, to help agents load only relevant files), **Exceptions** (when the rule
does not apply and who may grant it).

## Writing good rules

- Capture rules you have already paid for: a bug class that recurred, a review comment you repeated.
- One rule, one idea. If a rule has "and" in its title, split it.
- Prefer rules that can be enforced mechanically; promote them to lint rules or tests over time, and keep
  the standard as the explanation.
- Say what to do instead, not only what is forbidden.
- Keep a short **Applies to** line so the review agent loads the right files for a diff and ignores the rest.
- Retire rules the tooling now enforces or the code no longer needs; stale rules train agents to ignore the corpus.

## How agents find the right file

Agents read this README first, then open the files whose directory or **Applies to** matches the surfaces
they touch (an API route, a migration, a screen, an agent capability). Keep names and `Applies to` lines
accurate. Specs record in their Technical Design which standards they relied on; plans list them once;
reviews cite rule ids in findings (`DATA-3`), so every finding is traceable to a written rule or to plain
correctness.

## Changing a standard

Treat a standard like code: change it by pull request with a reason. A change that makes existing code
non-compliant needs a migration note or a dated exception list. Agents never edit `standards/` as part of
feature work unless the spec says to.
