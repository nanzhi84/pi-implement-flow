import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

export class PreflightError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type CommandName = 'prepare' | 'cleanup' | 'check' | 'accept' | 'publish';
type Role = { tools: string[]; extensions: string[]; instructions: string[] };
export interface Contract {
  version: 1;
  commands: Record<CommandName, string[]>;
  commandTimeoutMs: number;
  resources: { mode: 'exclusive' | 'isolated'; description: string };
  artifacts: { destination: string; retentionDays: number };
  agents: {
    implementation: Role;
    review: Role & { isolation: 'independent-context' };
    retry: { enabled: boolean; maxRetries: number; providerMaxRetries: 0 };
  };
}

function invalid(path: string): never {
  throw new PreflightError('CONTRACT_INVALID', `Check .pi/flow.json field: ${path}; see docs/execution-contract.md`);
}
function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !(key in result))) invalid(path);
  return result;
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) invalid(path);
  return value;
}
function integer(value: unknown, min: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid(path);
  return value;
}
function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path);
  return value.map(item => text(item, path));
}
function role(value: unknown, review: boolean): Role {
  const name = review ? 'agents.review' : 'agents.implementation';
  const role = object(value, ['tools', 'extensions', 'instructions', ...(review ? ['isolation'] : [])], name);
  const tools = strings(role.tools, `${name}.tools`);
  const allowed = review ? ['read', 'grep', 'find', 'ls'] : ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'];
  if (!tools.length || tools.some(tool => !allowed.includes(tool))) invalid(`${name}.tools`);
  const extensions = strings(role.extensions, `${name}.extensions`);
  // Extensions execute with host privileges. No child extensions are supported in this slice.
  if (extensions.length) invalid(`${name}.extensions (must be empty)`);
  const instructions = strings(role.instructions, `${name}.instructions`);
  if (!instructions.length) invalid(`${name}.instructions`);
  if (review && role.isolation !== 'independent-context') invalid(`${name}.isolation`);
  return { tools, extensions, instructions };
}

export async function readContract(cwd: string): Promise<Contract> {
  let source: string;
  try { source = await readFile(join(cwd, '.pi/flow.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PreflightError('CONTRACT_MISSING', 'Prepare .pi/flow.json before starting');
    }
    throw new PreflightError('CONTRACT_UNREADABLE', 'Cannot read .pi/flow.json; check local permissions');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { invalid('JSON syntax'); }
  const root = object(parsed, ['version', 'commands', 'commandTimeoutMs', 'resources', 'artifacts', 'agents'], 'root');
  if (root.version !== 1) invalid('version');
  const names: CommandName[] = ['prepare', 'cleanup', 'check', 'accept', 'publish'];
  const commands = object(root.commands, names, 'commands');
  const validated = {} as Record<CommandName, string[]>;
  for (const name of names) {
    validated[name] = strings(commands[name], `commands.${name}`);
    if (!validated[name].length) invalid(`commands.${name}`);
  }
  const commandTimeoutMs = integer(root.commandTimeoutMs, 1, 'commandTimeoutMs');
  if (commandTimeoutMs > 2_147_483_647) invalid('commandTimeoutMs (exceeds platform timer range)');
  const resources = object(root.resources, ['mode', 'description'], 'resources');
  if (resources.mode !== 'isolated' && resources.mode !== 'exclusive') invalid('resources.mode');
  const artifacts = object(root.artifacts, ['destination', 'retentionDays'], 'artifacts');
  const agents = object(root.agents, ['implementation', 'review', 'retry'], 'agents');
  const implementation = role(agents.implementation, false);
  const review = role(agents.review, true);
  const retry = object(agents.retry, ['enabled', 'maxRetries', 'providerMaxRetries'], 'agents.retry');
  if (typeof retry.enabled !== 'boolean' || retry.providerMaxRetries !== 0) invalid('agents.retry');
  const base = await realpath(cwd);
  for (const path of [...implementation.instructions, ...review.instructions]) {
    if (isAbsolute(path)) invalid('agents.*.instructions (project-relative files only)');
    try {
      const resolved = await realpath(join(base, path));
      const rel = relative(base, resolved);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !(await stat(resolved)).isFile()) invalid('agents.*.instructions');
    } catch { invalid('agents.*.instructions (missing or outside project)'); }
  }
  return {
    version: 1, commands: validated,
    commandTimeoutMs,
    resources: { mode: resources.mode, description: text(resources.description, 'resources.description') },
    artifacts: { destination: text(artifacts.destination, 'artifacts.destination'), retentionDays: integer(artifacts.retentionDays, 1, 'artifacts.retentionDays') },
    agents: { implementation, review: { ...review, isolation: 'independent-context' }, retry: {
      enabled: retry.enabled, maxRetries: integer(retry.maxRetries, 0, 'agents.retry.maxRetries'), providerMaxRetries: 0,
    } },
  };
}
