// solve.js — fast drop-in for makefun-diff 1.0.0 (v7, banded global Myers).
//
// Same answer as the reference, bit for bit (see v1 for the script rule).
// Speed comes from running ONE global Myers search whose diagonals are
// restricted to a band around the path the certified anchors trace. The
// anchors are maximal runs of lines unique in both texts (at least 3 long)
// whose drift matches the median drift of the unique lines in the +-40-line
// neighbourhood (a moved block fails this: its drift differs from the
// neighbourhood's by the move distance, 50-2,000 lines). The band keeps the
// search's V rows global, so the tie-breaking and the backtracked path are
// the reference's own; a plain restart per segment picks a different (but
// equally short) path where a line repeats, which the reference would not.
// If the banded search ever disagrees with the segment distances or fails
// to reach the end, the exact full search (v1) runs instead.

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

/**
 * The exact Myers edit runs of A[a0..a0+aLen] into B[b0..b0+bLen], as
 * {kind,count} runs (kind 0 keep, 1 delete, 2 insert), in order. This is
 * v1's search (prefix/suffix trim, greedy with deletion winning ties, no
 * edge pruning, snake-following, first path to reach both ends) run on one
 * slice. Used for the (small) segments, whose edit counts set the band.
 */
function diffRuns(A, a0, aLen, B, b0, bLen) {
  let prefix = 0;
  while (prefix < aLen && prefix < bLen && A[a0 + prefix] === B[b0 + prefix]) prefix++;
  let suffix = 0;
  while (suffix < aLen - prefix && suffix < bLen - prefix && A[a0 + aLen - 1 - suffix] === B[b0 + bLen - 1 - suffix]) suffix++;
  const N = aLen - prefix - suffix;
  const M = bLen - prefix - suffix;
  const s0 = a0 + prefix;
  const t0 = b0 + prefix;
  const rows = [];
  let x = 0;
  while (x < N && x < M && A[s0 + x] === B[t0 + x]) x++;
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
        while (xx < N && yy < M && A[s0 + xx] === B[t0 + yy]) {
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
  const s0x = rows[0][0];
  if (s0x > 0) rev.push([KEEP, s0x]);
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
  return runs;
}

/** Edit count (deletes + inserts) of a runs list. */
function editCount(runs) {
  let c = 0;
  for (const r of runs) if (r.kind !== KEEP) c += r.count;
  return c;
}

/**
 * The exact Myers edit runs of the whole middle region, found by a banded
 * global search. anchors are (i, j, len) in middle coordinates, on the
 * reference path; segDs are the edit counts of the segments before anchor 0,
 * between anchors, and after the last anchor. Returns the runs, or null when
 * the band does not reproduce the expected distance (caller falls back to
 * the full search).
 */
function bandedRuns(A, a0, N, B, b0, M, anchors, segDs) {
  const W = 96;
  const totalD = segDs.reduce((s, v) => s + v, 0);
  // d at each anchor start (a keep adds no edits), and k at each anchor.
  const dAt = [];
  const kAt = [];
  let dAcc = 0;
  for (let t = 0; t < anchors.length; t++) {
    dAcc += segDs[t];
    dAt.push(dAcc);
    kAt.push(anchors[t].i - anchors[t].j);
  }
  const dEnd = dAcc + segDs[anchors.length];
  // k expected at distance d, by linear interpolation between anchor k's.
  const kExp = (d) => {
    if (anchors.length === 0) return 0;
    if (d <= dAt[0]) return kAt[0];
    for (let t = 1; t < anchors.length; t++) {
      if (d <= dAt[t]) {
        const d0 = dAt[t - 1];
        const d1 = dAt[t];
        if (d1 === d0) return kAt[t];
        const f = (d - d0) / (d1 - d0);
        return kAt[t - 1] + f * (kAt[t] - kAt[t - 1]);
      }
    }
    return kAt[anchors.length - 1];
  };

  // rows[d] = { lo, arr } with arr[k - lo] = furthest x on diagonal k
  // (-1 where no path reaches), covering k in [lo, lo + arr.length).
  const rows = [];
  const kLo = [];
  let x = 0;
  while (x < N && x < M && A[a0 + x] === B[b0 + x]) x++;
  const lo0 = Math.floor(kExp(0)) - W;
  const hi0 = Math.floor(kExp(0)) + W;
  const r0 = new Int32Array(hi0 - lo0 + 1);
  r0.fill(-1);
  r0[0 - lo0] = x;
  rows.push({ lo: lo0, arr: r0 });
  kLo.push(lo0);
  let D = 0;
  let K = 0;
  let done = x >= N && x >= M;
  const getV = (row, k) => {
    const idx = k - row.lo;
    return idx < 0 || idx >= row.arr.length ? -1 : row.arr[idx];
  };
  if (!done) {
    for (let d = 1; d <= totalD && !done; d++) {
      const ke = Math.floor(kExp(d));
      const lo = ke - W;
      const hi = ke + W;
      const cur = new Int32Array(hi - lo + 1);
      cur.fill(-1);
      const prev = rows[d - 1];
      // k has the same parity as d, within [lo, hi].
      let kStart = lo;
      if (((kStart - d) & 1) !== 0) kStart++;
      for (let k = kStart; k <= hi; k += 2) {
        const vDel = k > -d ? getV(prev, k - 1) : -1;
        const vIns = k < d ? getV(prev, k + 1) : -1;
        const delAvail = vDel >= 0 && vDel < N;
        const insAvail = vIns >= 0 && vIns - k - 1 < M;
        if (!delAvail && !insAvail) continue;
        let xx;
        if (delAvail && (!insAvail || vDel + 1 >= vIns)) xx = vDel + 1;
        else xx = vIns;
        let yy = xx - k;
        while (xx < N && yy < M && A[a0 + xx] === B[b0 + yy]) {
          xx++;
          yy++;
        }
        cur[k - lo] = xx;
        if (xx >= N && yy >= M) {
          D = d;
          K = k;
          done = true;
          break;
        }
      }
      rows.push({ lo, arr: cur });
      kLo.push(lo);
    }
  }
  if (!done) return null;
  if (D !== totalD) return null;

  // Backtrack, exactly as v1, reading V through the banded rows.
  const rev = [];
  let k = K;
  x = N;
  for (let d = D; d >= 1; d--) {
    const prev = rows[d - 1];
    const vDel = k > -d ? getV(prev, k - 1) : -1;
    const vIns = k < d ? getV(prev, k + 1) : -1;
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
  const s0x = rows[0].arr[0 - rows[0].lo];
  if (s0x > 0) rev.push([KEEP, s0x]);
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const seg = rev[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === seg[0]) last.count += seg[1];
    else runs.push({ kind: seg[0], count: seg[1] });
  }
  // The backtracked path must keep every anchor line in full, at the
  // anchor's own (i, j); otherwise the band drifted and the caller falls back.
  let o = 0;
  let p = 0;
  let ai2 = 0;
  for (const r of runs) {
    const dO = r.kind === INSERT ? 0 : r.count;
    const dP = r.kind === DELETE ? 0 : r.count;
    while (ai2 < anchors.length && anchors[ai2].i < o + dO) {
      const an = anchors[ai2];
      if (an.i < o) { ai2++; continue; }
      if (r.kind !== KEEP) return null;
      if (p + (an.i - o) !== an.j) return null;
      if (an.i + an.len > o + r.count) return null;
      ai2++;
    }
    o += dO;
    p += dP;
  }
  if (ai2 < anchors.length) return null;
  return runs;
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
  const nIds = map.size;

  // Global counts (whole texts) and the position of each once-only new line.
  const cntA = new Int32Array(nIds);
  const cntB = new Int32Array(nIds);
  for (let i = 0; i < n; i++) cntA[ai[i]]++;
  for (let i = 0; i < m; i++) cntB[bi[i]]++;
  const posB = new Int32Array(nIds);
  posB.fill(-1);
  for (let i = 0; i < m; i++) if (cntB[bi[i]] === 1) posB[bi[i]] = i;
  const unique = (id) => cntA[id] === 1 && cntB[id] === 1;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;
  const N = n - prefix - suffix;
  const M = m - prefix - suffix;
  const a0 = prefix;
  const b0 = prefix;

  // Certified anchors in the middle region: maximal runs of lines unique
  // in both texts, at least 3 long, whose drift matches the median drift of
  // the unique lines in the +-40-line neighbourhood (excluding the run).
  const anchors = [];
  const WIN = 40;
  const TOL = 10;
  const MINLEN = 3;
  const MINSAMP = 5;
  let i = 0;
  while (i < N) {
    const X = a0 + i;
    const id = ai[X];
    if (!unique(id)) { i++; continue; }
    const Y = posB[id];
    const j = Y - b0;
    if (j < 0 || j >= M) { i++; continue; }
    let len = 0;
    while (i + len < N && j + len < M && ai[a0 + i + len] === bi[b0 + j + len] && unique(ai[a0 + i + len])) len++;
    if (len >= MINLEN) {
      const runDrift = Y - X;
      const drifts = [];
      for (let X2 = Math.max(a0, X - WIN); X2 < Math.min(a0 + N, X + len + WIN); X2++) {
        if (X2 >= X && X2 < X + len) continue;
        const id2 = ai[X2];
        if (!unique(id2)) continue;
        drifts.push(posB[id2] - X2);
      }
      let ok = false;
      if (drifts.length >= MINSAMP) {
        drifts.sort((p, q) => p - q);
        const med = drifts[(drifts.length / 2) | 0];
        ok = Math.abs(runDrift - med) <= TOL;
      }
      if (ok) {
        const last = anchors[anchors.length - 1];
        if (last === undefined || j > last.j) anchors.push({ i, j, len });
      }
    }
    i += Math.max(1, len);
  }

  // The middle region's runs: banded global search, falling back to the
  // exact full search when the band does not reproduce the segment distance.
  let midRuns = null;
  if (anchors.length > 0) {
    const segDs = [];
    let ci = 0;
    let cj = 0;
    for (const an of anchors) {
      segDs.push(editCount(diffRuns(ai, a0 + ci, an.i - ci, bi, b0 + cj, an.j - cj)));
      ci = an.i + an.len;
      cj = an.j + an.len;
    }
    segDs.push(editCount(diffRuns(ai, a0 + ci, N - ci, bi, b0 + cj, M - cj)));
    midRuns = bandedRuns(ai, a0, N, bi, b0, M, anchors, segDs);
  }
  if (midRuns === null) midRuns = diffRuns(ai, a0, N, bi, b0, M);

  // Runs in order: prefix, the middle region, suffix.
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  if (prefix > 0) pushRun(KEEP, prefix);
  for (const r of midRuns) pushRun(r.kind, r.count);
  if (suffix > 0) pushRun(KEEP, suffix);

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
      for (let i2 = 0; i2 < c.dels; i2++) out.push(written('-', a[c.o + i2]));
      for (let i2 = 0; i2 < c.ins; i2++) out.push(written('+', b[c.p + i2]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}
