import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { PreflightError, type Contract } from './contract.ts';
import { run } from './process.ts';

const excluded = new Set(['.git', 'node_modules']);
const output = (text: string) => ({
  content: [{ type: 'text' as const, text: text.length > 50_000 ? `${text.slice(0, 50_000)}\n[Output truncated]` : text }],
  details: undefined,
});
function refused(message = 'Path must stay inside the assigned worktree, without symlinks or .git') {
  return new PreflightError('AGENT_TOOL_REFUSED', message);
}

export interface RoleTools {
  tools: ToolDefinition[];
  settle(): Promise<void>;
}

// This limits supported tool operations; approved project commands are trusted
// code and neither these checks nor a worktree are an OS/credential sandbox.
export async function confinedTools(
  cwd: string, names: string[], contract: Contract, resources?: string, outerSignal?: AbortSignal, commandEnv?: NodeJS.ProcessEnv,
): Promise<RoleTools> {
  const root = await realpath(cwd);
  const active = new Set<Promise<unknown>>();
  let fatal: PreflightError | undefined;
  const guard = async (input: string, missing = false): Promise<string> => {
    // Owned worktrees may themselves live below the controller's .git directory.
    // Inspect only the requested suffix, never that trusted absolute root prefix.
    const requested = input === root || input.startsWith(`${root}${sep}`) ? input.slice(root.length) : input;
    if (!input || input.includes('\0') || requested.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw refused();
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refused();
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1)) throw refused();
        const canonical = await realpath(current);
        const local = relative(root, canonical);
        if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw refused();
      } catch (error) {
        if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return target;
  };
  const read = async (input: string): Promise<Buffer> => {
    const path = await guard(input);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > 4 * 1024 * 1024) throw refused('Read requires a regular worktree file of at most 4 MiB');
      return await handle.readFile();
    } finally { await handle.close(); }
  };
  const write = async (input: string, content: string) => {
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw refused('Write is limited to 4 MiB');
    const path = await guard(input, true);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1) throw refused();
      await handle.truncate(0);
      await handle.writeFile(content);
    } finally { await handle.close(); }
  };
  const entries = async (input: string) => {
    const path = await guard(input);
    return (await readdir(path, { withFileTypes: true })).filter(entry =>
      !excluded.has(entry.name.toLowerCase()) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()));
  };
  const files = async (input: string, signal?: AbortSignal) => {
    const start = await guard(input);
    if ((await lstat(start)).isFile()) return [start];
    const queue = [start];
    const result: string[] = [];
    let seen = 0;
    while (queue.length) {
      signal?.throwIfAborted();
      const folder = queue.shift()!;
      for (const entry of await entries(folder)) {
        if (++seen > 20_000) throw refused('Search exceeds 20000 entries; choose a narrower path');
        const path = await guard(join(folder, entry.name));
        if (entry.isDirectory()) queue.push(path);
        else result.push(path);
      }
    }
    return result;
  };
  const readTool = createReadToolDefinition(root, { operations: {
    readFile: read, access: async path => { await guard(path); },
  } });
  readTool.description += ' Confined to regular text files in this worktree, at most 4 MiB; symlinks and .git are refused.';
  const editTool = createEditToolDefinition(root, { operations: {
    readFile: read, writeFile: write, access: async path => { await guard(path); },
  } });
  const writeTool = createWriteToolDefinition(root, { operations: {
    writeFile: write,
    mkdir: async path => { await mkdir(await guard(path, true), { recursive: true }); await guard(path); },
  } });
  const lsTool = createLsToolDefinition(root, { operations: {
    exists: async path => { await guard(path); return true; },
    stat: async path => lstat(await guard(path)),
    readdir: async path => (await entries(path)).map(entry => entry.name),
  } });
  const findTool = createFindToolDefinition(root);
  findTool.description = 'Find regular worktree files using a glob. Excludes .git, node_modules and symlinks; does not apply .gitignore. Narrow path when a search exceeds 20000 entries.';
  findTool.execute = async (_id, params, signal) => {
    const start = await guard(params.path ?? '.');
    const limit = boundedLimit(params.limit, 500);
    const matches = (await files(start, signal)).filter(path =>
      matchesGlob(params.pattern.includes('/') ? relative(start, path) : basename(path), params.pattern));
    return output(matches.slice(0, limit).map(path => relative(root, path)).join('\n')
      + (matches.length > limit ? '\n[Result limit reached]' : '') || 'No matching files');
  };
  const grepTool = createGrepToolDefinition(root);
  grepTool.description = 'Search regular worktree files with ripgrep. Excludes .git, node_modules and symlinks; does not apply .gitignore. Pattern and glob are data, never shell commands.';
  grepTool.execute = async (_id, params, signal) => {
    const start = await guard(params.path ?? '.');
    let selected = await files(start, signal);
    if (params.glob) selected = selected.filter(path => matchesGlob(relative(start, path), params.glob!) || matchesGlob(basename(path), params.glob!));
    if (!selected.length) return output('No matching files');
    if (selected.reduce((sum, path) => sum + Buffer.byteLength(path) + 1, 0) > 100_000) throw refused('Search paths exceed command size; choose a narrower path');
    const args = ['rg', '--no-config', '--no-follow', '--json', '--color=never', '--max-count', String(boundedLimit(params.limit, 100))];
    if (params.ignoreCase) args.push('--ignore-case');
    if (params.literal) args.push('--fixed-strings');
    if (params.context) args.push('--context', String(Math.min(10, boundedLimit(params.context, 1))));
    args.push('--', params.pattern, ...selected);
    let text: string;
    try { text = await run(args, { cwd: root, signal, timeoutMs: contract.commandTimeoutMs, label: 'Agent grep' }); }
    catch (error) {
      // ripgrep's documented exit 1 means no matches; exit 2 remains a failure.
      if (error instanceof PreflightError && error.code === 'COMMAND_FAILED' && error.message.startsWith('Agent grep failed (exit 1);')) return output('No matches');
      throw error;
    }
    const lines: string[] = [];
    for (const line of text.split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type !== 'match' && event.type !== 'context') continue;
      const path = event.data?.path?.text;
      const content = event.data?.lines?.text;
      if (typeof path !== 'string' || typeof content !== 'string') continue;
      await guard(path);
      lines.push(`${relative(root, path)}:${event.data.line_number}:${content.trimEnd()}`);
      if (lines.length >= boundedLimit(params.limit, 100)) { lines.push('[Result limit reached]'); break; }
    }
    return output(lines.join('\n') || 'No matches');
  };
  const bashTool = createBashToolDefinition(root);
  bashTool.description = 'Run one approved project command. command must be exactly prepare, check or accept. Arbitrary shell, Git and GitHub operations are unavailable.';
  bashTool.promptSnippet = 'Run an approved project command by name';
  bashTool.promptGuidelines = ['Use command "prepare", "check", or "accept" without arguments. Other shell commands are refused.'];
  bashTool.execute = async (_id, params, signal) => {
    if (!['prepare', 'check', 'accept'].includes(params.command) || params.timeout !== undefined || !resources) throw refused('Only approved prepare/check/accept commands without extra parameters are supported');
    const phase = params.command as 'prepare' | 'check' | 'accept';
    const text = await run(contract.commands[phase], {
      cwd: root, signal, timeoutMs: contract.commandTimeoutMs, label: `Agent ${phase}`,
      env: { ...commandEnv, FLOW_RESOURCE_DIR: resources },
    });
    return output(text || `${phase} completed; this is not delivery evidence`);
  };
  const definitions: ToolDefinition<any, any>[] = [readTool, editTool, writeTool, lsTool, findTool, grepTool, bashTool];
  const registry = new Map(definitions.map(tool => [tool.name, tool]));
  const tools = names.map(name => {
    const tool = registry.get(name);
    if (!tool) throw refused('Unsupported configured Agent tool');
    return {
      ...tool, executionMode: 'sequential' as const,
      execute: async (...args: Parameters<ToolDefinition['execute']>) => {
        const signal = outerSignal && args[2] ? AbortSignal.any([outerSignal, args[2]]) : outerSignal ?? args[2];
        signal?.throwIfAborted();
        if (fatal) throw fatal;
        const work = (async () => {
          const params = args[1] as { path?: string };
          if (name !== 'bash') await guard(params.path ?? '.', name === 'write');
          return tool.execute(args[0], args[1], signal, args[3], args[4]);
        })();
        active.add(work);
        try { return await work; }
        catch (error) {
          if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') fatal = error;
          throw error;
        } finally { active.delete(work); }
      },
    };
  });
  return { tools, async settle() { await Promise.allSettled([...active]); if (fatal) throw fatal; } };
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw refused('Search limit must be a positive integer');
  return Math.min(value, 1000);
}
