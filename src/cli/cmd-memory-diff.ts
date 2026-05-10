/**
 * `relay memory diff <id1> <id2> [--json]` — content diff between two memories.
 *
 * Fetches both memories by id and emits a unified line-level diff of their
 * `content` fields. No external dependencies — uses an inline LCS algorithm
 * for the longest common subsequence so output mirrors `diff -u` semantics
 * (additions/deletions grouped into hunks).
 *
 * Exit codes:
 *   0 — diff computed (whether identical or not)
 *   1 — one or both memory ids not found
 *   2 — missing arguments (handled by dispatcher)
 *
 * Human mode: red `-` deletions, green `+` additions, dim hunk headers.
 * --json mode: structured `{a, b, additions, deletions, hunks}` payload.
 */
import type { CliIO } from './commands.js';
import { MemoryStore } from '../memory/memory-store.js';
import { c } from './colors.js';
import type { Memory } from '../memory/types.js';

export interface DiffOp {
  readonly kind: 'eq' | 'add' | 'del';
  readonly a_line?: number; // 1-based line in A (eq, del)
  readonly b_line?: number; // 1-based line in B (eq, add)
  readonly text: string;
}

export interface DiffHunk {
  readonly a_start: number; // 1-based; 0 if no context (pure additions at top)
  readonly a_count: number;
  readonly b_start: number;
  readonly b_count: number;
  readonly ops: readonly DiffOp[];
}

/**
 * Compute longest-common-subsequence table for two arrays. Returns a flat
 * (n+1) * (m+1) table. O(n*m) time/memory; fine for memory contents that
 * are typically <100 lines. Memories larger than that are an anti-pattern
 * and the diff still works — just slower.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const n = a.length;
  const m = b.length;
  const t = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) t[i * w + j] = t[(i - 1) * w + (j - 1)] + 1;
      else t[i * w + j] = Math.max(t[(i - 1) * w + j], t[i * w + (j - 1)]);
    }
  }
  return t;
}

/** Walk the LCS table backwards to produce an in-order op stream. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  const t = lcsTable(a, b);
  const w = b.length + 1;
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'eq', a_line: i, b_line: j, text: a[i - 1]! });
      i--; j--;
    } else if (j > 0 && (i === 0 || t[i * w + (j - 1)]! >= t[(i - 1) * w + j]!)) {
      ops.push({ kind: 'add', b_line: j, text: b[j - 1]! });
      j--;
    } else {
      ops.push({ kind: 'del', a_line: i, text: a[i - 1]! });
      i--;
    }
  }
  return ops.reverse();
}

/** Group ops into hunks with up to `context` lines of unchanged context per hunk. */
export function buildHunks(ops: readonly DiffOp[], context: number = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === 'eq') { i++; continue; }
    // Found a change at i — extend backwards for context, then forwards.
    const start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end]!.kind !== 'eq') { end++; continue; }
      // Look ahead to see if there's another change within `context * 2` lines —
      // if so, keep extending; otherwise close the hunk after `context` eq lines.
      let nextChange = -1;
      for (let k = end; k < Math.min(ops.length, end + context * 2 + 1); k++) {
        if (ops[k]!.kind !== 'eq') { nextChange = k; break; }
      }
      if (nextChange === -1) break;
      end = nextChange;
    }
    const tail = Math.min(ops.length, end + context);
    const slice = ops.slice(start, tail);
    let aStart = 0, aCount = 0, bStart = 0, bCount = 0;
    for (const op of slice) {
      if (op.kind !== 'add') {
        if (aStart === 0 && op.a_line !== undefined) aStart = op.a_line;
        if (op.a_line !== undefined) aCount++;
      }
      if (op.kind !== 'del') {
        if (bStart === 0 && op.b_line !== undefined) bStart = op.b_line;
        if (op.b_line !== undefined) bCount++;
      }
    }
    hunks.push({ a_start: aStart, a_count: aCount, b_start: bStart, b_count: bCount, ops: slice });
    i = tail;
  }
  return hunks;
}

function memorySummary(m: Memory): Record<string, unknown> {
  return {
    id: m.memory_id,
    type: m.memory_type,
    content: m.content,
    workdir: m.workdir,
    pinned: m.pinned,
    trust_level: m.trust_level,
    tags: m.tags,
    created_at: m.created_at,
  };
}

function renderText(a: Memory, b: Memory, hunks: readonly DiffHunk[], add: number, del: number): string {
  const out: string[] = [];
  out.push(c.bold(`--- ${a.memory_id} (${a.memory_type})`));
  out.push(c.bold(`+++ ${b.memory_id} (${b.memory_type})`));
  if (hunks.length === 0) {
    out.push(c.dim('(identical content)'));
    return out.join('\n') + '\n';
  }
  for (const h of hunks) {
    out.push(c.cyan(`@@ -${h.a_start},${h.a_count} +${h.b_start},${h.b_count} @@`));
    for (const op of h.ops) {
      if (op.kind === 'eq') out.push(c.dim(' ' + op.text));
      else if (op.kind === 'add') out.push(c.green('+' + op.text));
      else out.push(c.red('-' + op.text));
    }
  }
  out.push('');
  out.push(c.dim(`${del} deletion(s), ${add} addition(s)`));
  return out.join('\n') + '\n';
}

export function executeMemoryDiffCommand(
  command: { idA: string; idB: string; json: boolean },
  io: CliIO
): number {
  const store = new MemoryStore();
  const a = store.getMemory(command.idA);
  const b = store.getMemory(command.idB);
  const missing: string[] = [];
  if (!a) missing.push(command.idA);
  if (!b) missing.push(command.idB);
  if (missing.length > 0) {
    if (command.json) {
      io.stdout(JSON.stringify({ error: 'not_found', missing }) + '\n');
    } else {
      io.stderr(`Memory not found: ${missing.join(', ')}\n`);
    }
    return 1;
  }

  const aLines = a!.content.split('\n');
  const bLines = b!.content.split('\n');
  const ops = diffLines(aLines, bLines);
  const hunks = buildHunks(ops);
  const additions = ops.filter(o => o.kind === 'add').length;
  const deletions = ops.filter(o => o.kind === 'del').length;

  if (command.json) {
    io.stdout(JSON.stringify({
      a: memorySummary(a!),
      b: memorySummary(b!),
      additions,
      deletions,
      hunks: hunks.map(h => ({
        a_start: h.a_start,
        a_count: h.a_count,
        b_start: h.b_start,
        b_count: h.b_count,
        ops: h.ops.map(op => ({
          kind: op.kind,
          ...(op.a_line !== undefined ? { a_line: op.a_line } : {}),
          ...(op.b_line !== undefined ? { b_line: op.b_line } : {}),
          text: op.text,
        })),
      })),
    }) + '\n');
    return 0;
  }

  io.stdout(renderText(a!, b!, hunks, additions, deletions));
  return 0;
}
