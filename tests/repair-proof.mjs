import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hash = value => createHash('sha256').update(value).digest('hex');
export function verifyProof(project, proof, codeSha) {
  const raw = (...args) => execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16_000_000 });
  const text = (...args) => raw(...args).toString('utf8').trim();
  assert.equal(proof.schema, 2); assert.equal(proof.source, 'controller-code-segments');
  assert.ok(proof.segments.length);
  const shas = [proof.origin, proof.head, codeSha, ...proof.segments.flatMap(segment => [segment.from, segment.head, ...(segment.preparation ? [segment.preparation.B] : [])])];
  for (const sha of shas) assert.match(sha, /^[a-f0-9]{40}$/);
  raw('fetch', '--quiet', 'origin', ...new Set(shas));
  const file = (tree, path) => {
    const entries = raw('ls-tree', '-z', tree, '--', `:(literal)${path}`).toString('utf8').split('\0').filter(Boolean);
    if (!entries.length) return null;
    assert.equal(entries.length, 1);
    const [identity, actual] = entries[0].split('\t'); const [mode, kind, oid] = identity.split(' ');
    assert.equal(actual, path); assert.equal(kind, 'blob'); assert.ok(['100644', '100755'].includes(mode));
    return { mode, hash: hash(raw('cat-file', 'blob', oid)) };
  };
  function edits(from, head, events) {
    const changed = raw('diff', '--name-only', '-z', '--no-renames', from, head, '--').toString('utf8').split('\0').filter(Boolean);
    const latest = new Map();
    for (const [index, event] of events.entries()) {
      assert.equal(event.order, index + 1); assert.notEqual(event.beforeSha256, event.afterSha256);
      assert.equal(event.beforeSha256, latest.has(event.path) ? latest.get(event.path) : file(from, event.path)?.hash ?? null);
      assert.match(event.afterSha256, /^[a-f0-9]{64}$/);
      if (Object.hasOwn(event, 'matchesDeliveredFile')) assert.equal(event.matchesDeliveredFile, event.afterSha256 === file(codeSha, event.path)?.hash);
      latest.set(event.path, event.afterSha256);
    }
    for (const path of changed) assert.ok(latest.has(path), 'all effective Agent changes require observed events');
    for (const [path, last] of latest) {
      assert.equal(last, file(head, path)?.hash); assert.equal(file(head, path)?.mode, file(from, path)?.mode ?? '100644');
    }
  }
  let previous = proof.origin;
  for (const segment of proof.segments) {
    assert.equal(segment.from, previous);
    const parents = text('show', '-s', '--format=%P', segment.head).split(' ');
    if (segment.kind === 'agent-edit') { assert.deepEqual(parents, [previous]); edits(previous, segment.head, segment.mutations); }
    else {
      assert.equal(segment.kind, 'controller-merge'); const p = segment.preparation;
      assert.equal(p.H, previous); assert.deepEqual(parents, [previous, p.B]);
      assert.deepEqual(p.mergeBases, text('merge-base', '--all', p.H, p.B).split('\n').sort());
      assert.deepEqual(p.profile, { kind: 'builtin-ort-v1', gitVersion: text('--version') });
      const temporary = mkdtempSync(join(tmpdir(), 'flow-independent-merge-'));
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
        GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OBJECT_DIRECTORY: text('rev-parse', '--path-format=absolute', '--git-path', 'objects') });
      let bytes;
      try {
        execFileSync('git', ['init', '--bare', '--template=', '.'], { cwd: temporary, env, stdio: 'pipe' });
        try { bytes = execFileSync('git', ['-c', 'merge.conflictStyle=merge', '-c', 'merge.renormalize=false', 'merge-tree', '--write-tree', '--messages', '-z', p.H, p.B], { cwd: temporary, env, stdio: 'pipe' }); }
        catch (error) { assert.equal(error.status, 1); bytes = error.stdout; }
      } finally { rmSync(temporary, { recursive: true, force: true }); }
      const fields = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
      assert.equal(fields.shift(), p.preparedTree);
      const conflicts = new Map();
      for (let field = fields.shift(); field; field = fields.shift()) {
        const match = /^(\d+) ([a-f0-9]{40}) ([123])\t(.+)$/.exec(field); assert.ok(match);
        conflicts.set(match[4], [...(conflicts.get(match[4]) ?? []), { stage: Number(match[3]), mode: match[1], oid: match[2] }]);
      }
      assert.deepEqual([...conflicts].sort(([a], [b]) => a.localeCompare(b)).map(([path, stages]) => ({ path, stages })), p.conflicts);
      edits(p.preparedTree, segment.head, segment.resolutionMutations);
    }
    previous = segment.head;
  }
  assert.equal(previous, proof.head);
}
