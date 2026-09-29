import { PreflightError } from './contract.ts';

import { run } from './process.ts';

async function command(cwd: string, program: string, args: string[]): Promise<string> {
  try {
    return await run([program, ...args], { cwd, timeoutMs: 30_000, label: `Read-only ${program}`,
      operation: program === 'gh' ? 'github-read' : 'git-read' });
  } catch (error) {
    if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
    // Do not surface subprocess output, URLs with credentials, or private local paths.
    throw new PreflightError('REMOTE_READ_FAILED', `Read-only ${program} operation failed; check authentication, network and permissions; no automatic retry`, error instanceof PreflightError ? error.detail : undefined);
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
  private constructor(readonly repository: string, private readonly cwd: string, readonly identity: string = repository) {}
  static async fromOrigin(cwd: string): Promise<GitHub> {
    const origin = (await command(cwd, 'git', ['remote', 'get-url', 'origin'])).trim();
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
    if (!match?.[1]) throw new PreflightError('REMOTE_UNSUPPORTED', 'origin must be a credential-free github.com repository URL');
    const candidate = new GitHub(match[1], cwd);
    const canonical = record(await candidate.get(''));
    if (!Number.isSafeInteger(canonical.id) || typeof canonical.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(canonical.full_name)) {
      throw new PreflightError('REMOTE_INVALID', 'Cannot establish canonical GitHub repository identity');
    }
    return new GitHub(canonical.full_name, cwd, `github.com:${canonical.id}`);
  }
  private async get(path: string, paginated = false): Promise<unknown> {
    const output = await command(this.cwd, 'gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      ...(paginated ? ['--paginate', '--slurp'] : []), `repos/${this.repository}${path ? `/${path}` : ''}`]);
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
    const repository = record(await this.get(''));
    const permissions = record(repository.permissions);
    if (permissions.push !== true || repository.has_issues !== true || repository.default_branch !== 'main') {
      throw new PreflightError('PERMISSION_UNAVAILABLE', 'Need a main-based repository with Issues enabled and effective push permission; do not use admin bypass');
    }
    let rules: unknown[];
    let classicCount: unknown;
    try {
      // A 403/404 is not proof of no policy. Classic wildcard rules may apply to
      // branches that do not exist yet; this slice conservatively rejects them.
      rules = await this.list(`rules/branches/${encodeURIComponent(featureBranch)}`);
      const [owner, name] = this.repository.split('/');
      const response = JSON.parse(await command(this.cwd, 'gh', ['api', '--hostname', 'github.com', 'graphql',
        '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){branchProtectionRules(first:1){totalCount}}}',
        '-f', `owner=${owner}`, '-f', `name=${name}`]));
      classicCount = record(record(record(record(response).data).repository).branchProtectionRules).totalCount;
      if (!Number.isSafeInteger(classicCount) || (classicCount as number) < 0) throw new Error('Invalid classic policy response');
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      throw new PreflightError('PROTECTION_UNVERIFIABLE', 'Cannot inspect rulesets and classic branch protection; check repository plan and rule-read permissions', error instanceof PreflightError ? error.detail : undefined);
    }
    if (rules.some(rule => record(rule).type === 'pull_request')) {
      throw new PreflightError('NATIVE_REVIEW_UNAVAILABLE', 'Feature-branch pull-request policy needs verified native review/check capabilities; same-author internal review cannot approve on GitHub; this policy is not supported yet');
    }
    if (rules.length || classicCount !== 0) {
      throw new PreflightError('PROTECTION_UNSUPPORTED', 'Active rules or classic wildcard protection need explicit supported policy evaluation; refuse rather than assume no requirements or use admin bypass');
    }
  }
}
