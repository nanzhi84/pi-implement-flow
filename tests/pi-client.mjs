import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Real pi protocol, not an emulation of ExtensionAPI. No prompt reaches a model.
export async function openPi(cwd, agentDir) {
  const child = spawn(process.env.PI_BIN ?? 'pi', [
    '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-tools',
    '--no-approve', '--offline', '-e', fileURLToPath(new URL('../src/extension.ts', import.meta.url)),
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notices = [];
  let serial = 0;
  let confirm = false;
  // Deliberately do not capture stderr: third-party diagnostics may contain private paths.
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'response') pending.get(event.id)?.(event);
    if (event.type === 'extension_ui_request') {
      if (event.method === 'notify') notices.push(event.message);
      if (event.method === 'confirm') {
        child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, confirmed: confirm }) + '\n');
      }
    }
  });
  function request(type, fields = {}) {
    const id = String(++serial);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`pi ${type} timeout`));
      }, 60_000);
      pending.set(id, result => { clearTimeout(timeout); pending.delete(id); resolve(result); });
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
    });
  }
  const client = {
    request,
    notices,
    async flow(args, accepted = false) {
      confirm = accepted;
      const start = notices.length;
      const result = await request('prompt', { message: `/flow ${args}` });
      if (!result.success) throw new Error('pi rejected command');
      return notices.slice(start).join('\n');
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(kill);
    },
  };
  try {
    const response = await request('get_commands');
    if (!response.data?.commands?.some(command => command.name === 'flow')) {
      throw new Error('Real pi did not register /flow; refusing to send a model prompt');
    }
    return client;
  } catch (error) { await client.close(); throw error; }
}
