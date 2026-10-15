# Example rule file: Data access

> Copy this file, rename it for your subject (for example `backend/data-access.md`), and replace the
> content. See `standards/README.md` for the format and how the kit consumes it.

**Applies to:** `**/db/**`, `**/repositories/**`, any file that builds or runs a query.

## DATA-1: Parameterise every query

- **Severity:** critical
- **Rule:** Pass user-controlled values to the database as bound parameters, never by string
  concatenation or interpolation. Concatenated values are an injection vector and defeat plan caching.
- **Detection:** Grep changed files for query calls whose first argument contains `+`, a template
  literal with `${`, or `format(`; review each hit for user-controlled input.
- **Example:**
  - Violation: ``db.query(`select * from orders where id = ${id}`)``
  - Correct: `db.query('select * from orders where id = $1', [id])`

## DATA-2: Every new table declares its ownership column

- **Severity:** warning
- **Rule:** A new table that holds one tenant's or one owner's rows has an explicit owner column that
  leads its primary key and unique constraints, so access checks and future partitioning do not need a
  schema change.
- **Detection:** In each new migration, find `create table` statements; check for the owner column and that
  it is the first column of every key. A table that is global by design says so in a comment.
- **Example:**
  - Violation: `create table notes (id uuid primary key, body text)`
  - Correct: `create table notes (owner_id uuid, id uuid, body text, primary key (owner_id, id))`
- **Exceptions:** Reference data shared by all owners.

## DATA-3: Migrations are immutable once merged

- **Severity:** critical
- **Rule:** Never edit a migration that has been merged; add a new one. Applied migrations are history
  that other environments have already run.
- **Detection:** `git diff <base>...HEAD --name-status -- '**/migrations/**'` shows `M` (modified) or
  `D` (deleted) for any file that exists on the base branch.
- **Example:**
  - Violation: editing `0004_add_status.sql` to add a column.
  - Correct: add `0007_add_status_column.sql` with the change.
