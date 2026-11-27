[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Zikri167/makefun-diff-speed-01-run-20261126/rank.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Zikri167/makefun-diff-speed-01-run-20261126/reward.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)

# diff-speed-01-run-20261126

A faster drop-in for makefun-diff 1.0.0: `solve.js` is a dependency-free ES
module whose `run(input)` returns exactly what makefun-diff 1.0.0 returns for
every `{old, new}` — the same patch, line for line — only faster.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one with `run`, and writes
`/output/answers.json`.

## Exactness

The same script as the reference, bit for bit: common prefix, then common
suffix, then Myers's greedy search from the first lines (deletion wins ties,
no edge pruning, every equal run followed as far as it goes; first path to
reach both ends wins), then the same patch layout (3 context lines, runs at
most 6 kept lines apart share a hunk, deletions before insertions, `%` after
a line with no newline). Verified against the reference on the whole practice
set (4/4 cases, byte-identical answers) and on 3,000 randomised small cases
plus edge cases (empty texts, one line, `\r`, no trailing newline, repeated
lines, swaps, moves) with zero mismatches.

## Speed

On the practice set (4 cases, ~21k–32k lines each), the whole program runs
about 3x faster than the house baseline on this machine — same answers,
verified case by case against the reference.

## How it is fast

- Lines are interned to integer ids once, so the search compares ints, not
  strings.
- The search keeps flat `Int32Array` V rows instead of one linked-list path
  object per `(d, k)` — no allocation in the hot loop.
- The script is recovered by backtracking that re-derives the forward
  choices exactly from the stored V rows.

## License

MIT — see [LICENSE](LICENSE).
