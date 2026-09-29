import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [mode, command, ...args] = process.argv.slice(2);
if (!['accept-failure', 'actual-merge-recheck-fails', 'evidence-unavailable'].includes(mode) || !command) process.exit(97);
const result = spawnSync(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
if (result.error || result.signal || result.status !== 0) process.exit(result.status || 98);
if (mode === 'evidence-unavailable') {
  const sentinel = Buffer.from('FLOW_UTF8_SENTINEL:\uFFFD:END');
  const start = result.stdout.indexOf(sentinel);
  if (start < 0 || result.stdout.indexOf(sentinel, start + 1) !== -1) process.exit(96);
  const position = start + Buffer.byteLength('FLOW_UTF8_SENTINEL:');
  const corrupted = Buffer.concat([result.stdout.subarray(0, position), Buffer.from([0xff]), result.stdout.subarray(position + 3)]);
  // FF decodes to U+FFFD, just like the original EF BF BD. Only raw hashing detects this change.
  if (corrupted.toString('utf8') !== result.stdout.toString('utf8')) process.exit(95);
  let invalidUtf8 = false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(corrupted); } catch { invalidUtf8 = true; }
  if (!invalidUtf8) process.exit(94);
  const hash = value => createHash('sha256').update(value).digest('hex');
  process.stdout.write(corrupted);
  process.stderr.write(`INTEGRATION_FAULT_BYTES: ${JSON.stringify({ originalSha256: hash(result.stdout), corruptedSha256: hash(corrupted),
    originalBytes: result.stdout.length, corruptedBytes: corrupted.length, decodedEqual: true, invalidUtf8 })}\n`);
  process.stderr.write('INTEGRATION_FAULT_APPLIED: evidence-unavailable\n');
} else {
  process.stdout.write(`INTEGRATION_FAULT_APPLIED: ${mode}\n`);
  process.exitCode = 1; // The real assertion command ran; its caller observes failure.
}
