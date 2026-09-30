import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const [url, scenario, command, ...args] = process.argv.slice(2);
const ticket = Number(process.env.FLOW_TICKET); const phase = process.env.FLOW_STAGE;
const kind = args[1];
const post = async (route, data) => {
  const result = await fetch(`${url}/${route}`, { method: 'POST', body: JSON.stringify(data) });
  if (!result.ok) throw new Error('Synthetic resource observer refused operation');
  return result.json();
};
try {
  if (scenario === 'exclusive-real-resource' && kind === 'prepare') await post('acquire', { ticket, phase });
  if (kind === 'prepare' && phase === 'candidate') await post('before-candidate', { ticket, phase });
  const failedCleanup = scenario === 'parallel-unknown-retains-cleanup' && kind === 'cleanup'
    && phase === 'implementation' && String(ticket) === process.env.FLOW_PAIR_TICKETS.split(',')[1];
  if (failedCleanup) await post('cleanup-hold', { ticket, phase });
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  if (exit.code !== 0 || exit.signal) { process.exitCode = exit.code || 1; }
  else {
    if (scenario === 'real-openai-diamond' && kind === 'prepare' && phase === 'implementation'
      && process.env.FLOW_PAIR_TICKETS.split(',').includes(String(ticket))) {
      const key = 'shared-logical-key'; const value = `ticket-${ticket}`;
      const file = join(process.env.FLOW_RESOURCE_DIR, 'parallel-key.json');
      await writeFile(file, JSON.stringify({ key, value }));
      const server = createServer(async (req, res) => {
        if (req.url !== `/${key}`) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(await readFile(file));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try { await post('pair', { ticket, key, value, port: server.address().port }); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
    if (scenario === 'exclusive-real-resource' && kind === 'cleanup') await post('release', { ticket, phase });
    if (failedCleanup) {
      await writeFile(join(process.env.FLOW_RESOURCE_DIR, 'synthetic-cleanup-retained.json'), JSON.stringify({ ticket, cleanupFailed: true }));
      process.stderr.write('Synthetic cleanup failure after the real command; retain this owned resource\n'); process.exitCode = 1;
    }
  }
} catch { process.stderr.write('Scheduling resource fixture failed\n'); process.exitCode = 1; }
