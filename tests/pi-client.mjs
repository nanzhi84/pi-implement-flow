import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Real pi protocol, not an emulation of ExtensionAPI. No prompt reaches a model.
export async function openPi(cwd, agentDir, options = {}) {
  const child = spawn(process.env.PI_BIN ?? 'pi', [
    '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-tools',
    '--no-approve', '--offline', '-e', fileURLToPath(new URL('../src/extension.ts', import.meta.url)),
    ...(options.model ? ['--provider', options.model.provider, '--model', options.model.id] : []),
    ...(options.extensions ?? []).flatMap(path => ['-e', path]),
  ], { cwd, env: { ...process.env, ...options.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notices = [];
  let serial = 0;
  let confirm = false;
  let processFailure;
  function failPending(message) {
    processFailure = new Error(message);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(processFailure);
    }
    pending.clear();
  }
  child.on('error', () => failPending('pi process could not start'));
  child.on('exit', () => failPending('pi process exited'));
  child.stdin.on('error', () => failPending('pi input stream failed'));
  // Deliberately do not capture stderr: third-party diagnostics may contain private paths.
  child.stderr.resume();
  function lineReceived(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'response') {
      const waiter = pending.get(event.id);
      if (waiter) {
        clearTimeout(waiter.timeout);
        pending.delete(event.id);
        waiter.resolve(event);
      }
    }
    if (event.type === 'extension_ui_request') {
      if (event.method === 'notify') notices.push(event.message);
      if (event.method === 'confirm') {
        Promise.resolve(options.onConfirm ? options.onConfirm(event) : confirm).then(confirmed => {
          child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, confirmed }) + '\n');
        }).catch(() => failPending('Acceptance client could not answer confirmation'));
      }
    }
  }
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      lineReceived(line);
    }
  });
  function request(type, fields = {}) {
    if (processFailure) return Promise.reject(processFailure);
    const id = String(++serial);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`pi ${type} timeout`));
      }, options.timeoutMs ?? 120_000);
      pending.set(id, { resolve, reject, timeout });
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
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
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
