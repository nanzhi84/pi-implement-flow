import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PreflightError } from './contract.ts';

const execute = promisify(execFile);

async function command(cwd: string, program: string, args: string[]): Promise<string> {
  try {
    const result = await execute(program, args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    return result.stdout;
  } catch {
    // Do not surface subprocess output, URLs with credentials, or private local paths.
    throw new PreflightError('REMOTE_READ_FAILED', `Read-only ${program} operation failed; check authentication, network and permissions; no automatic retry`);
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PreflightError('REMOTE_INVALID', 'GitHub returned an unexpected response');
  }
  return value as Record<string, unknown>;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  repository: string;
}
function issue(value: unknown): Issue {
  const data = record(value);
  if (!Number.isSafeInteger(data.number) || (data.number as number) < 1 || typeof data.title !== 'string'
    || typeof data.body !== 'string' || typeof data.repository_url !== 'string'
    || !['open', 'closed'].includes(data.state as string) || data.pull_request) {
    throw new PreflightError('PLAN_INVALID', 'Expected GitHub Issues with nonempty planning bodies, not PRs');
  }
  return { number: data.number as number, title: data.title, body: data.body,
    state: data.state as Issue['state'], repository: data.repository_url };
}

export class GitHub {
  private constructor(readonly repository: string, private readonly cwd: string) {}
  static async fromOrigin(cwd: string): Promise<GitHub> {
    const origin = (await command(cwd, 'git', ['remote', 'get-url', 'origin'])).trim();
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
    if (!match?.[1]) throw new PreflightError('REMOTE_UNSUPPORTED', 'origin must be a credential-free github.com repository URL');
    return new GitHub(match[1], cwd);
  }
  private async get(path: string, paginated = false): Promise<unknown> {
    const output = await command(this.cwd, 'gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      ...(paginated ? ['--paginate', '--slurp'] : []), `repos/${this.repository}/${path}`]);
    try { return JSON.parse(output); }
    catch { throw new PreflightError('REMOTE_INVALID', 'GitHub response is not JSON'); }
  }
  private async list(path: string): Promise<unknown[]> {
    const pages = await this.get(`${path}?per_page=100`, true);
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
      throw new PreflightError('REMOTE_INVALID', 'GitHub pagination response is invalid');
    }
    return pages.flat();
  }
  async issue(number: number): Promise<Issue> { return issue(await this.get(`issues/${number}`)); }
  async children(number: number): Promise<Issue[]> { return (await this.list(`issues/${number}/sub_issues`)).map(issue); }
  async blockers(number: number): Promise<Issue[]> { return (await this.list(`issues/${number}/dependencies/blocked_by`)).map(issue); }

  async inspectProtection(featureBranch: string): Promise<void> {
    try {
      // Rule visibility is mandatory. A 403/404 is not proof of no applicable rules.
      await this.list(`rules/branches/${encodeURIComponent(featureBranch)}`);
    } catch {
      throw new PreflightError('PROTECTION_UNVERIFIABLE',
        'Cannot read active GitHub branch rules. Check repository plan and rule-read permission; never treat inaccessible rules as absent');
    }
    // Classic protection, identities, environment probes and start remain intentionally blocked.
    throw new PreflightError('PREFLIGHT_INCOMPLETE',
      'Rules are readable, but classic protection, reviewer readiness, environment probes and safe start are not implemented yet');
  }
}
