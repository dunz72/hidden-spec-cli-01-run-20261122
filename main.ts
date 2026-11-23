// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies
// the edits AI models write, in four formats, to a tree of text files. It does all
// ten sections of SPEC.md: the command line, the output and exit codes, safe paths,
// format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON
// edits (section 9) and the all-or-nothing write (section 10). Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves that succeeded, as [old, new] pairs, so the output can print one `R` line for each. */
const MOVES: Array<[string, string]> = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- Files: lines, line break, final break (SPEC.md section 3) ----------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- Matching lines at three tiers (SPEC.md section 5) ----------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyWs = (s: string): boolean => s !== '' && /^[ \t]+$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(fileLines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences, or null. */
function findTier(fileLines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

/**
 * The lines N writes for a matched O at `at`, in body order. A context line is
 * written as the file's own matched line, never the patch's. At tier 2 every
 * other line of N is re-indented: a line that is not empty and not only
 * whitespace, and starts with P (the leading spaces and tabs of O's first
 * line), has that P replaced by F (those of the file's first matched line).
 */
function buildN(fileLines: string[], at: number, body: BodyLine[], tier: number): string[] {
  const o: string[] = [];
  for (const b of body) if (b.kind === ' ' || b.kind === '-') o.push(b.text);
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = at < fileLines.length ? leadWs(fileLines[at]!) : '';
  const out: string[] = [];
  let oPos = 0;
  for (const b of body) {
    if (b.kind === '\\') continue;
    if (b.kind === ' ') {
      out.push(fileLines[at + oPos]!);
      oPos += 1;
    } else if (b.kind === '-') {
      oPos += 1;
    } else if (tier === 2 && b.text !== '' && !onlyWs(b.text) && b.text.startsWith(p)) {
      out.push(f + b.text.slice(p.length));
    } else {
      out.push(b.text);
    }
  }
  return out;
}

// ---------- JSON edits (SPEC.md section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Unified diffs (SPEC.md section 6) ----------

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path of a `--- ` or `+++ ` line: the text after the four characters, up to the first tab, with surrounding spaces removed. A leading `a/` or `b/` is removed from either. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let rawBody: string[] | null = null;
  let hunkA = 0;
  const freshSection = (): USection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const flushBody = (): void => {
    if (rawBody === null || cur === null) return;
    while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') rawBody.pop();
    const body: BodyLine[] = rawBody.map((l) => {
      if (l === '') return { kind: ' ', text: '' };
      const c = l[0]!;
      if (c === ' ') return { kind: ' ', text: l.slice(1) };
      if (c === '-') return { kind: '-', text: l.slice(1) };
      if (c === '+') return { kind: '+', text: l.slice(1) };
      return { kind: '\\', text: l.slice(1) };
    });
    cur.hunks.push({ a: hunkA, body });
    rawBody = null;
  };
  const newSection = (s: USection): void => {
    flushBody();
    cur = s;
    sections.push(s);
    inHeader = true;
  };
  const diffSection = (line: string, i: number): USection => {
    const m = DIFF_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const s = freshSection();
    s.diffOld = m[1]!;
    s.diffNew = m[2]!;
    return s;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (rawBody !== null) {
      if (line.startsWith('diff --git ')) {
        newSection(diffSection(line, i));
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = freshSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        newSection(s);
        i += 1;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        rawBody.push(line);
        continue;
      }
      flushBody();
    }
    if (line.startsWith('diff --git ')) {
      newSection(diffSection(line, i));
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 1;
        continue;
      }
      const s = freshSection();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      newSection(s);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunkA = parseInt(m[1]!, 10);
      rawBody = [];
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      continue;
    }
  }
  flushBody();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One hunk applied to a file state. `d` is the sum over this section's hunks applied so far of (N's length minus O's length). */
function applyHunk(fs: FileState, hunk: UHunk, d: number, strict: boolean, path: string): { fs: FileState; delta: number } {
  const o: string[] = [];
  for (const b of hunk.body) if (b.kind === ' ' || b.kind === '-') o.push(b.text);
  let lastCP = -1;
  for (let i = hunk.body.length - 1; i >= 0; i -= 1) {
    if (hunk.body[i]!.kind === ' ' || hunk.body[i]!.kind === '+') {
      lastCP = i;
      break;
    }
  }
  const backslash = lastCP >= 0 && hunk.body[lastCP + 1] !== undefined && hunk.body[lastCP + 1]!.kind === '\\';
  if (o.length === 0) {
    const plus = hunk.body.filter((b) => b.kind === '+').map((b) => b.text);
    let idx = hunk.a + d;
    if (idx < 0) idx = 0;
    if (idx > fs.lines.length) idx = fs.lines.length;
    const lines = [...fs.lines.slice(0, idx), ...plus, ...fs.lines.slice(idx)];
    const final = idx === fs.lines.length ? !backslash : fs.final;
    return { fs: { lines, br: fs.br, final }, delta: plus.length };
  }
  const found = findTier(fs.lines, o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let at = found.occ[0]!;
  let best = Math.abs(at - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      at = p;
      best = dist;
    }
  }
  const rep = buildN(fs.lines, at, hunk.body, found.tier);
  const lines = [...fs.lines.slice(0, at), ...rep, ...fs.lines.slice(at + o.length)];
  const runsToEnd = at + o.length === fs.lines.length;
  const final = runsToEnd ? !backslash : fs.final;
  return { fs: { lines, br: fs.br, final }, delta: rep.length - o.length };
}

function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  let fs = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(fs, h, d, strict, path);
    fs = r.fs;
    d += r.delta;
  }
  return serializeFile(fs);
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  if (isCreate) {
    return (tree) => {
      if (newP === null || newP === undefined) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let finalBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = sec.hunks[hi]!;
        let lastPlus = -1;
        for (let i = h.body.length - 1; i >= 0; i -= 1) {
          if (h.body[i]!.kind === '+') {
            lastPlus = i;
            break;
          }
        }
        if (lastPlus < 0) continue;
        finalBreak = !(h.body[lastPlus + 1] !== undefined && h.body[lastPlus + 1]!.kind === '\\');
        break;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (oldP === null || oldP === undefined) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, result);
      MOVES.push([oldP, newP]);
    };
  }
  return (tree) => {
    const p = oldP !== undefined && oldP !== null ? oldP : newP;
    if (p === undefined || p === null) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let e = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        e = j;
        break;
      }
    }
    if (e === -1) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r === -1) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, e), newLines: lines.slice(e + 1, r) });
    prevPath = path;
    prevEnd = r + 1;
    i = r + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  if (b.oldLines.length === 0) {
    return (tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const fs = parseFile(before);
    const body: BodyLine[] = [
      ...b.oldLines.map((t) => ({ kind: '-' as BodyKind, text: t })),
      ...b.newLines.map((t) => ({ kind: '+' as BodyKind, text: t })),
    ];
    const found = findTier(fs.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.occ[0]!;
    const rep = buildN(fs.lines, at, body, found.tier);
    const lines = [...fs.lines.slice(0, at), ...rep, ...fs.lines.slice(at + b.oldLines.length)];
    tree.now.set(b.path, serializeFile({ lines, br: fs.br, final: fs.final }));
  };
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  chunks: VChunk[];
  fileLines: string[];
}

function parseVSection(kind: 'add' | 'delete' | 'update', path: string, startLine: number, raw: string[], contentStart: number): VSection {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${contentStart + k + 1}`);
    }
    return { kind, path, line: startLine, moveTo: null, chunks: [], fileLines };
  }
  if (kind === 'delete') {
    for (let k = 0; k < raw.length; k += 1) throw new Exit2(`error: parse ${contentStart + k + 1}`);
    return { kind, path, line: startLine, moveTo: null, chunks: [], fileLines: [] };
  }
  let moveTo: string | null = null;
  let j = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    j = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; j < raw.length; j += 1) {
    const l = raw[j]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
    } else if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${contentStart + j + 1}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${contentStart + j + 1}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push(
        l === ''
          ? { kind: ' ', text: '' }
          : l[0] === ' '
            ? { kind: ' ', text: l.slice(1) }
            : l[0] === '-'
              ? { kind: '-', text: l.slice(1) }
              : { kind: '+', text: l.slice(1) },
      );
    } else {
      throw new Exit2(`error: parse ${contentStart + j + 1}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
  return { kind, path, line: startLine, moveTo, chunks, fileLines: [] };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i += 1;
    const contentStart = i;
    const raw: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push(l);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    sections.push(parseVSection(kind, path, startLine, raw, contentStart));
  }
  return sections.map((s) => vSectionEdit(s, strict));
}

/** The first line at or after `from` equal to the anchor at the first tier where one is, or null. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk takes only an occurrence that ends at the file's last line. */
function findChunk(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { at: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from).filter((p) => !eof || p + o.length === lines.length);
    if (occ.length > 0) return { at: occ[0]!, tier: t };
  }
  return null;
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const fs0 = parseFile(before);
    let lines = fs0.lines;
    let cursor = 0;
    for (const c of s.chunks) {
      if (c.anchor !== null) {
        const found = findAnchor(lines, c.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const o: string[] = [];
      for (const b of c.body) if (b.kind === ' ' || b.kind === '-') o.push(b.text);
      if (o.length === 0) {
        const ins = c.body.filter((b) => b.kind === '+').map((b) => b.text);
        const idx = c.eof ? lines.length : cursor;
        lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
        cursor = idx + ins.length;
        continue;
      }
      const found = findChunk(lines, o, cursor, strict, c.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const rep = buildN(lines, found.at, c.body, found.tier);
      lines = [...lines.slice(0, found.at), ...rep, ...lines.slice(found.at + o.length)];
      cursor = found.at + rep.length;
    }
    const out = serializeFile({ lines, br: fs0.br, final: fs0.final });
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      MOVES.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------- Invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  MOVES.length = 0;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of MOVES) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const di = rows.findIndex((r) => r.line === `D ${oldP}`);
      const ai = rows.findIndex((r) => r.line === `A ${newP}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort(
    (a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0),
  );
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
