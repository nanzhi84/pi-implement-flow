import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [mode, command, ...args] = process.argv.slice(2);
const modes = ['github-eof', 'github-permanent', 'gate-behavior', 'gate-infrastructure', 'gate-configuration',
  'gate-unclassified', 'gate-invalid-report', 'gate-success-contradiction', 'gate-timeout-report'];
if (!modes.includes(mode) || !command) process.exit(97);
const actual = spawnSync(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
if (actual.error || actual.signal || actual.status !== 0) {
  process.stderr.write('INFRASTRUCTURE_PRECONDITION_FAILED\n');
  process.exit(actual.status || 98);
}
if (mode.startsWith('github-')) {
  process.stderr.write(mode === 'github-eof' ? 'unexpected EOF\n' : 'HTTP 403: resource not accessible; permission denied\n');
  process.stderr.write('FLOW_SYNTHETIC_SECRET_DO_NOT_PUBLISH\nINFRASTRUCTURE_FAULT_APPLIED\n');
  process.exitCode = 1;
} else {
  const report = { schema: 'flow-command-failure-v1', kind: 'behavior', codeSha: process.env.FLOW_CODE_SHA,
    assertions: [{ name: 'greeting-for-name', passed: true }, { name: 'synthetic-required-behavior', passed: false }] };
  if (mode === 'gate-invalid-report') report.codeSha = '0'.repeat(40);
  if (['gate-infrastructure', 'gate-configuration'].includes(mode)) {
    report.kind = 'execution'; delete report.assertions;
    report.category = mode === 'gate-infrastructure' ? 'infrastructure' : 'configuration';
    report.reason = mode === 'gate-infrastructure' ? 'connection-refused' : 'missing-dependency';
  }
  const bytes = Buffer.from(mode === 'gate-unclassified' ? 'unclassified synthetic exit 1\n' : JSON.stringify(report) + '\n');
  process.stdout.write(bytes);
  process.stderr.write(`INFRASTRUCTURE_REPORT: ${JSON.stringify({ codeSha: process.env.FLOW_CODE_SHA,
    reportDigest: createHash('sha256').update(bytes).digest('hex') })}\n`);
  process.stderr.write('FLOW_SYNTHETIC_SECRET_DO_NOT_PUBLISH\nINFRASTRUCTURE_FAULT_APPLIED\n');
  if (mode === 'gate-timeout-report') setInterval(() => {}, 1000);
  else process.exitCode = mode === 'gate-success-contradiction' ? 0 : 1;
}
