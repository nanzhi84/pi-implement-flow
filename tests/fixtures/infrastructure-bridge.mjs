import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { repository, assertRepositoryIdentity } from '../acceptance-repository.mjs';

export default function infrastructureBridge(pi) {
  const key = Symbol.for('pi-flow.test.infrastructure-bridge.v1');
  const state = globalThis[key] ??= { spawn: childProcess.spawn, attempts: 0, applied: 0, configured: false };
  const modes = ['github-eof', 'github-permanent', 'github-certificate-expired', 'github-certificate-untrusted', 'github-tls-unknown',
    'gate-behavior', 'gate-infrastructure', 'gate-configuration',
    'gate-unclassified', 'gate-invalid-report', 'gate-success-contradiction', 'gate-timeout-report'];
  pi.registerCommand('fixture-infrastructure', { handler: async (text, ctx) => {
    const config = JSON.parse(text);
    if (state.configured || config.repository !== repository || !modes.includes(config.mode)
      || !Number.isSafeInteger(config.spec) || config.spec <= 0) throw new Error('Invalid infrastructure fixture identity');
    const opts = { cwd: ctx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 };
    if (childProcess.execFileSync('git', ['remote', 'get-url', 'origin'], opts).trim() !== `https://github.com/${repository}.git`) throw new Error('Fixture origin mismatch');
    assertRepositoryIdentity(JSON.parse(childProcess.execFileSync('gh', ['api', `repos/${repository}`], opts)));
    Object.assign(state, config, { configured: true });
    childProcess.spawn = function (command, args, options) {
      const ghRead = state.mode.startsWith('github-') && command === 'gh'
        && args.includes(`repos/${repository}/issues/${state.spec}`) && args.includes('GET');
      const projectCommand = state.mode.startsWith('gate-') && args?.[0] === 'fixture.mjs'
        && args[1] === 'accept' && options?.env?.FLOW_STAGE === 'candidate';
      if (!ghRead && !projectCommand) return state.spawn.call(this, command, args, options);
      state.attempts += 1;
      const child = state.spawn.call(this, process.execPath,
        [fileURLToPath(new URL('./infrastructure-command.mjs', import.meta.url)), state.mode, command, ...args], options);
      let stderr = ''; let counted = false;
      child.stderr?.on('data', chunk => {
        stderr = `${stderr}${chunk}`.slice(-4096);
        const report = /INFRASTRUCTURE_REPORT: (\{[^\n]+\})/.exec(stderr);
        if (report) state.report = JSON.parse(report[1]);
        if (!counted && stderr.includes('INFRASTRUCTURE_FAULT_APPLIED')) { counted = true; state.applied += 1; }
      });
      return child;
    };
    syncBuiltinESMExports();
  } });
  pi.registerCommand('fixture-infrastructure-status', { handler: async (_text, ctx) => {
    ctx.ui.notify(`INFRASTRUCTURE_OBSERVER: ${JSON.stringify({ mode: state.mode, attempts: state.attempts, applied: state.applied, report: state.report })}`, 'info');
  } });
  pi.on('session_shutdown', () => { childProcess.spawn = state.spawn; syncBuiltinESMExports(); });
}
