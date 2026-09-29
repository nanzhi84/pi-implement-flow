import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { PreflightError } from './contract.ts';

// Ephemeral OS ownership only; no flow/attempt ledger. A stale socket is never stolen.
// Keying by remote identity excludes other clones/worktrees in the same OS account.
export async function claimRepository(repository: string): Promise<() => Promise<void>> {
  const key = createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 24);
  const path = `/tmp/pi-flow-${process.getuid?.() ?? 'user'}-${key}.sock`;
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
  } catch {
    throw new PreflightError('FLOW_OWNED', 'Another controller owns this repository, or a stale socket needs explicit process reconciliation; never auto-steal');
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closed = true;
  };
  try { await chmod(path, 0o600); } catch { await close(); throw new PreflightError('CONTROL_UNAVAILABLE', 'Cannot restrict local controller socket permissions'); }
  return close;
}
