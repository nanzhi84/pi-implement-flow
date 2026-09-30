import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Test transport only: execute the real read, then expose its already-observed
// computation-in-progress shape. No GitHub write, retry or invented ready C.
const args = process.argv.slice(2);
const path = `repos/nanzhi84/pi-implement-flow-repair-acceptance/pulls/${process.env.FLOW_FIXTURE_PR}`;
assert.equal(args.includes(path), true);
assert.equal(args[args.indexOf('--method') + 1], 'GET');
const result = spawnSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 16_000_000 });
if (result.error || result.signal) process.exit(97);
if (result.status !== 0) {
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status);
}
const pr = JSON.parse(result.stdout);
assert.equal(pr.number, Number(process.env.FLOW_FIXTURE_PR));
assert.equal(pr.head.sha, process.env.FLOW_FIXTURE_HEAD);
assert.equal(pr.merged, false); assert.equal(pr.state, 'open');
assert.match(process.env.FLOW_FIXTURE_OLD_C, /^[a-f0-9]{40}$/);
process.stdout.write(JSON.stringify({ ...pr, mergeable: null, merge_commit_sha: process.env.FLOW_FIXTURE_OLD_C }));
