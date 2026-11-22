// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: { old: string; new: string }[] = [];
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

// ---------- file line model (SPEC §3) and matching (SPEC §5) ----------
interface FileModel { br: string; lines: string[]; finalBr: boolean; }
function fileModel(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}
function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function stripTier(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function tiers(strict: boolean): number[] { return strict ? [0] : [0, 1, 2]; }
function findOcc(lines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const t of tiers(strict)) {
    const pos: number[] = [];
    const o = oldLines.map((l) => stripTier(l, t));
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (stripTier(lines[i + j]!, t) !== o[j]) { ok = false; break; }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}
interface NewItem { text: string; ctx: number | null; }
function buildNew(oldLines: string[], items: NewItem[], lines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = pos < lines.length ? lead(lines[pos]!) : '';
  const p = oldLines.length > 0 ? lead(oldLines[0]!) : '';
  for (const it of items) {
    if (it.ctx !== null) { out.push(lines[pos + it.ctx]!); continue; }
    if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) out.push(f + it.text.slice(p.length));
    else out.push(it.text);
  }
  return out;
}
interface BodyLine { kind: string; text: string; }
interface Hunk { a: number; body: BodyLine[]; }
function hunkNoEol(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i--) {
    const k = h.body[i]!.kind;
    if (k === ' ' || k === '+') return i + 1 < h.body.length && h.body[i + 1]!.kind === '\\';
  }
  return false;
}
function hunkON(h: Hunk): { o: string[]; items: NewItem[] } {
  const o: string[] = [];
  const items: NewItem[] = [];
  for (const bl of h.body) {
    if (bl.kind === ' ') { items.push({ text: bl.text, ctx: o.length }); o.push(bl.text); }
    else if (bl.kind === '-') o.push(bl.text);
    else if (bl.kind === '+') items.push({ text: bl.text, ctx: null });
  }
  return { o, items };
}
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const fm = fileModel(before);
  const lines = [...fm.lines];
  let finalBr = fm.finalBr;
  let d = 0;
  for (const h of hunks) {
    const { o, items } = hunkON(h);
    if (o.length > 0) {
      const found = findOcc(lines, o, strict);
      if (!found) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < best) { best = dist; pos = p; }
      }
      const runsToEnd = pos + o.length === lines.length;
      const repl = buildNew(o, items, lines, pos, found.tier);
      lines.splice(pos, o.length, ...repl);
      if (runsToEnd) finalBr = !hunkNoEol(h);
      d += items.length - o.length;
    } else {
      const idx = Math.min(h.a + d, lines.length);
      const runsToEnd = idx === lines.length;
      const repl = items.map((it) => it.text);
      lines.splice(idx, 0, ...repl);
      if (runsToEnd) finalBr = !hunkNoEol(h);
      d += items.length;
    }
  }
  return joinFile(lines, fm.br, finalBr);
}

// ---------- unified diffs (SPEC §6) ----------
interface UniSection {
  oldP: string | null; newP: string | null;
  isCreate: boolean; isDelete: boolean; hunks: Hunk[];
}
function parsePathField(s: string): string {
  const t = s.split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}
function isDiffGit(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}
function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)$/.exec(line.trimEnd());
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Builder {
    dashOld: string | null; dashNew: string | null; hasPair: boolean;
    renOld: string | null; renNew: string | null;
    diffOld: string | null; diffNew: string | null;
    isCreate: boolean; isDelete: boolean; hunks: Hunk[]; inHeader: boolean;
  }
  const newBuilder = (): Builder => ({
    dashOld: null, dashNew: null, hasPair: false, renOld: null, renNew: null,
    diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [], inHeader: true,
  });
  const sections: UniSection[] = [];
  let b: Builder | null = null;
  const close = () => {
    if (!b) return;
    let oldP = b.hasPair ? b.dashOld : (b.renOld ?? b.diffOld);
    let newP = b.hasPair ? b.dashNew : (b.renNew ?? b.diffNew);
    if (oldP === '/dev/null') oldP = null;
    if (newP === '/dev/null') newP = null;
    sections.push({ oldP, newP, isCreate: b.isCreate, isDelete: b.isDelete, hunks: b.hunks });
    b = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const [x, y] = parseDiffGit(line, i + 1);
      close();
      b = newBuilder();
      b.diffOld = x; b.diffNew = y;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (b && b.inHeader && !b.hasPair) {
        b.dashOld = parsePathField(line.slice(4));
        b.dashNew = parsePathField(lines[i + 1]!.slice(4));
        b.hasPair = true;
        i++;
        continue;
      }
      close();
      b = newBuilder();
      b.dashOld = parsePathField(line.slice(4));
      b.dashNew = parsePathField(lines[i + 1]!.slice(4));
      b.hasPair = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (b && b.inHeader) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      if (!b) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (isDiffGit(l)) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push({ kind: l[0]!, text: l[0] === '\\' ? l : l.slice(1) });
          j++;
          continue;
        }
        if (l === '') { body.push({ kind: ' ', text: '' }); j++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      b.hunks.push({ a: parseInt(m[1]!, 10), body });
      b.inHeader = false;
      i = j - 1;
      continue;
    }
    if (b && b.inHeader) {
      if (line.startsWith('new file mode')) b.isCreate = true;
      else if (line.startsWith('deleted file mode')) b.isDelete = true;
      else if (line.startsWith('rename from ')) b.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) b.renNew = line.slice(10).trim();
      continue;
    }
  }
  close();
  return sections.map((s) => uniSectionEdit(s, strict));
}
function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    if (s.isCreate || s.oldP === null) {
      const np = s.newP ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const bl of h.body) if (bl.kind === '+') plus.push(bl.text);
      let finalBr = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        for (let bi = h.body.length - 1; bi >= 0; bi--) {
          if (h.body[bi]!.kind === '+') {
            if (bi + 1 < h.body.length && h.body[bi + 1]!.kind === '\\') finalBr = false;
            break outer;
          }
        }
      }
      tree.now.set(np, joinFile(plus, '\n', finalBr));
      return;
    }
    if (s.isDelete || s.newP === null) {
      const op = s.oldP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (s.oldP !== s.newP) {
      const op = s.oldP!;
      const np = s.newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, s.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push({ old: op, new: np });
      return;
    }
    const p = s.oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC §7) ----------
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let bound = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= bound; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    bound = rep + 1;
    i = rep + 1;
  }
  return edits;
}
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fm = fileModel(before);
    const found = findOcc(fm.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const items: NewItem[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildNew(oldLines, items, fm.lines, pos, found.tier);
    const ls = [...fm.lines];
    ls.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(ls, fm.br, fm.finalBr));
  };
}

// ---------- V4A patches (SPEC §8) ----------
interface VChunk { anchor: string | null; eof: boolean; body: BodyLine[]; }
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    const raw = lines.slice(i + 1, j);
    let end = raw.length;
    while (end > 0 && blank(raw[end - 1]!)) end--;
    const secLines = raw.slice(0, end);
    const secLineNo = (k: number): number => i + 2 + k;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${secLineNo(k)}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(fileLines, '\n', true));
      });
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      for (let k = 0; k < secLines.length; k++) throw new Exit2(`error: parse ${secLineNo(k)}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = line.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = idx; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${secLineNo(k)}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur) chunks.push(cur);
          const at = l.slice(2).trim();
          cur = { anchor: at === '' ? null : at, eof: false, body: [] };
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!cur) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${secLineNo(k)}`);
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}
function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fm = fileModel(before);
    const lines = [...fm.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const af = findOcc(lines, [ch.anchor], strict, cursor);
        if (!af) throw new Fail('no-match', p);
        cursor = af.positions[0]! + 1;
      }
      const { o, items } = hunkON({ a: 0, body: ch.body });
      if (ch.eof) {
        if (o.length === 0) {
          const repl = items.map((it) => it.text);
          lines.splice(lines.length, 0, ...repl);
          cursor = lines.length;
        } else {
          const found = findOcc(lines, o, strict, cursor);
          if (!found) throw new Fail('no-match', p);
          let pos = -1;
          for (const cand of found.positions) {
            if (cand + o.length === lines.length) { pos = cand; break; }
          }
          if (pos < 0) throw new Fail('no-match', p);
          const repl = buildNew(o, items, lines, pos, found.tier);
          lines.splice(pos, o.length, ...repl);
          cursor = pos + repl.length;
        }
      } else if (o.length === 0) {
        const repl = items.map((it) => it.text);
        lines.splice(cursor, 0, ...repl);
        cursor += repl.length;
      } else {
        const found = findOcc(lines, o, strict, cursor);
        if (!found) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const repl = buildNew(o, items, lines, pos, found.tier);
        lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = joinFile(lines, fm.br, fm.finalBr);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

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
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
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
  const changed: { key: string; row: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of tree.moves) {
    const oldOrig = tree.original(mv.old);
    const newOrig = tree.original(mv.new);
    if (oldOrig !== null && tree.get(mv.old) === null && newOrig === null && tree.get(mv.new) !== null) {
      changed.push({ key: mv.new, row: `R ${mv.old} -> ${mv.new}` });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  const changedPaths = new Set<string>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changedPaths.add(p);
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.row);
  if (!check) {
    for (const p of [...changedPaths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
