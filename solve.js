// solve.js — fast drop-in for makefun-diff 1.0.0.
//
// Same script as the reference, bit for bit: common prefix, then common suffix,
// then Myers's greedy search from the first lines (deletion wins ties, no edge
// pruning, every equal run followed as far as it goes; first path to reach both
// ends wins), then the same patch layout (3 context lines, runs <= 6 kept lines
// apart share a hunk, deletions before insertions, "%" after a line with no
// newline). What differs is only the machinery: lines are interned to integer
// ids once (so the hot loop compares ints, not strings), the search keeps flat
// Int32Array V rows instead of one linked-list path object per (d, k), and the
// script is recovered by backtracking that re-derives the forward choices
// exactly from those rows.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Split text into lines (each with its "\n", except a last line without one) and intern them. */
function tokenize(text, map, strs, ids) {
  let start = 0;
  const len = text.length;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? len : nl + 1;
    const line = text.slice(start, end);
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    strs.push(line);
    ids.push(id);
    start = end;
  }
}

/** A line as the patch writes it: op, the line, a newline, "%" on its own line when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const a = [];
  const b = [];
  const aIds = [];
  const bIds = [];
  tokenize(input.old, map, a, aIds);
  tokenize(input.new, map, b, bIds);
  const ai = Int32Array.from(aIds);
  const bi = Int32Array.from(bIds);
  const n = a.length;
  const m = b.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;
  const N = n - prefix - suffix;
  const M = m - prefix - suffix;
  const A = ai.subarray(prefix, n - suffix);
  const B = bi.subarray(prefix, m - suffix);

  // Myers's greedy search: rows[d] is the furthest x on each diagonal k after
  // d edits and the snake (-1 where no path reaches). Row d has 2d+1 entries,
  // index j = k + d.
  const rows = [];
  let x = 0;
  while (x < N && x < M && A[x] === B[x]) x++;
  const r0 = new Int32Array(1);
  r0[0] = x;
  rows.push(r0);
  let D = 0;
  let K = 0;
  if (!(x >= N && x >= M)) {
    let done = false;
    for (let d = 1; d <= N + M && !done; d++) {
      const prev = rows[d - 1];
      const cur = new Int32Array(2 * d + 1);
      cur.fill(-1);
      for (let k = -d; k <= d; k += 2) {
        const j = k + d;
        const vDel = k > -d ? prev[j - 2] : -1;
        const vIns = k < d ? prev[j] : -1;
        const delAvail = vDel >= 0 && vDel < N;
        const insAvail = vIns >= 0 && vIns - k - 1 < M;
        if (!delAvail && !insAvail) continue;
        let xx;
        if (delAvail && (!insAvail || vDel + 1 >= vIns)) xx = vDel + 1;
        else xx = vIns;
        let yy = xx - k;
        while (xx < N && yy < M && A[xx] === B[yy]) {
          xx++;
          yy++;
        }
        cur[j] = xx;
        if (xx >= N && yy >= M) {
          D = d;
          K = k;
          done = true;
          break;
        }
      }
      rows.push(cur);
    }
    if (!done) throw new Error('makefun-diff: the search ended without reaching both ends');
  }

  // Backtrack: re-derive each level's move from the stored rows, exactly as
  // the forward pass chose it, collecting segments in reverse.
  const rev = [];
  let k = K;
  x = N;
  for (let d = D; d >= 1; d--) {
    const prev = rows[d - 1];
    const j = k + d;
    const vDel = k > -d ? prev[j - 2] : -1;
    const vIns = k < d ? prev[j] : -1;
    const delAvail = vDel >= 0 && vDel < N;
    const insAvail = vIns >= 0 && vIns - k - 1 < M;
    let xPre;
    let isDel;
    if (delAvail && (!insAvail || vDel + 1 >= vIns)) {
      xPre = vDel + 1;
      isDel = true;
    } else {
      xPre = vIns;
      isDel = false;
    }
    const snake = x - xPre;
    if (snake > 0) rev.push([KEEP, snake]);
    rev.push([isDel ? DELETE : INSERT, 1]);
    if (isDel) {
      k = k - 1;
      x = vDel;
    } else {
      k = k + 1;
      x = vIns;
    }
  }
  const s0 = rows[0][0];
  if (s0 > 0) rev.push([KEEP, s0]);

  // Runs in order, merging neighbours of one kind (prefix/suffix included).
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (let i = rev.length - 1; i >= 0; i--) {
    const seg = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === seg[0]) last.count += seg[1];
    else runs.push({ kind: seg[0], count: seg[1] });
  }
  if (suffix > 0) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === KEEP) last.count += suffix;
    else runs.push({ kind: KEEP, count: suffix });
  }

  // The change runs.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}
