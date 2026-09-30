import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { api, fixture, repository } from './execution-fixture.mjs';
import { assertRepositoryIdentity } from './acceptance-repository.mjs';

// Harness reconciliation only, after the scenario's actual pi processes exit.
// Live ownership assertions remain in the E2E body; no remote operation is replayed.
export async function infrastructureFixture(t, scenario, options) {
  const identity = api(`repos/${repository}`);
  assertRepositoryIdentity(identity);
  const key = createHash('sha256').update(`github.com:${identity.id}`).digest('hex').slice(0, 24);
  const socket = `/tmp/pi-flow-${process.getuid()}-${key}.sock`;
  await assert.rejects(lstat(socket), { code: 'ENOENT' }, 'never take over an existing controller or stale socket');
  const f = await fixture(t, scenario, options);
  const clients = [];
  const open = f.open;
  f.open = async extra => { const client = await open(extra); clients.push(client); return client; };
  // The base fixture closes first; explicitly await every known client here too.
  t.after(async () => {
    for (const client of clients) await client.close();
    let before;
    try { before = await lstat(socket); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.equal(before.isSocket(), true, 'never remove a non-socket resource');
    assert.equal(before.uid, process.getuid(), 'never remove another user\'s control resource');
    let noOwner = false;
    try { execFileSync('lsof', ['-t', socket], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }); }
    catch (error) { noOwner = error.status === 1 && error.stderr?.length === 0; }
    assert.equal(noOwner, true, 'never remove a live or indeterminate controller socket');
    const after = await lstat(socket);
    assert.equal(after.dev, before.dev, 'never remove a replaced controller socket');
    assert.equal(after.ino, before.ino, 'never remove a replaced controller socket');
    await rm(socket);
  });
  return f;
}
