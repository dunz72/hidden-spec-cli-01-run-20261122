# mend — one patch tool for every AI edit format

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dunz72/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dunz72/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [make.fun](https://make.fun) bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
($100, top 10 places paid, closes 24 Nov 2026 21:00 WIB).
Referral code: `rwrq8ddk`.

Agent harnesses apply edits that models write, and models write them in four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format and text-editor tool calls as JSON. `mend` reads all four
to one written specification, finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, or `-`/absent to read the patch from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R <old> -> <new>`
for a move) and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage, no-patch,
format or parse error, one `error: ...` line.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone, nothing
  installed before the program runs.
- `runner.ts` — the kit's trial runner (kept as it is).
- `check.ts` — the practice set on your own machine:
  `node check.ts <practice.json>` prints every check it gets wrong and the
  practice score. The practice set scores 1000/1000 with this entry.

## Specification

`SPEC.md` in the kit's starter is the whole specification: the command line,
output and exit codes, safe paths, format detection, line matching at three
tiers (exact, trailing whitespace, both sides trimmed), unified diffs,
SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write.
