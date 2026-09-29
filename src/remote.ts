import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreflightError } from './contract.ts';
import { run } from './process.ts';

export interface PullRequest {
  number: number; html_url: string; state: 'open' | 'closed'; draft: boolean; body: string;
  merged: boolean; merge_commit_sha: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
}
export interface Comment { id: number; html_url: string; body: string; user: { login: string }; }
function validComment(value: unknown, repository: string, number: number): value is Comment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Comment;
  return Number.isSafeInteger(item.id) && item.id > 0 && typeof item.body === 'string'
    && [`https://github.com/${repository}/issues/${number}#issuecomment-${item.id}`,
      `https://github.com/${repository}/pull/${number}#issuecomment-${item.id}`].includes(item.html_url)
    && typeof item.user?.login === 'string';
}
function validPull(value: unknown, repository: string, details = false): value is PullRequest {
  if (!value || typeof value !== 'object') return false;
  const pr = value as PullRequest;
  return Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.html_url === `https://github.com/${repository}/pull/${pr.number}`
    && ['open', 'closed'].includes(pr.state) && typeof pr.draft === 'boolean' && typeof pr.body === 'string'
    && [pr.head, pr.base].every(ref => ref && typeof ref.ref === 'string' && /^[a-f0-9]{40}$/.test(ref.sha)
      && ref.repo?.full_name?.toLowerCase() === repository.toLowerCase())
    && (!details || (typeof pr.merged === 'boolean'
      && (pr.merge_commit_sha === null || /^[a-f0-9]{40}$/.test(pr.merge_commit_sha))));
}

// Each write is one request. Failure is unknown, never an invitation to retry.
// Temporary request payloads are removed and are not an execution ledger.
export class Remote {
  constructor(readonly cwd: string, readonly repository: string, private readonly signal?: AbortSignal) {}

  async api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let temporary: string | undefined;
    let primary: unknown;
    let sent = false;
    try {
      const args = ['gh', 'api', '--hostname', 'github.com', '--method', method, `repos/${this.repository}${path ? `/${path}` : ''}`];
      if (body !== undefined) {
        temporary = await mkdtemp(join(tmpdir(), 'pi-flow-request-'));
        const file = join(temporary, 'request.json');
        await writeFile(file, JSON.stringify(body), { mode: 0o600 });
        args.push('--input', file);
      }
      if (method !== 'GET') this.signal?.throwIfAborted();
      // Once sent, do not cancel a remote write and guess its outcome. Read it back.
      sent = true;
      const output = await run(args, { cwd: this.cwd, timeoutMs: 30_000, label: `GitHub ${method}` });
      return output.trim() ? JSON.parse(output) as T : undefined as T;
    } catch (error) {
      primary = !sent && this.signal?.aborted ? this.signal.reason
        : error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED' ? error
        : new PreflightError(method === 'GET' ? 'REMOTE_READ_FAILED' : 'REMOTE_RESULT_UNKNOWN',
        `${method} ${path.split('?')[0]} could not be confirmed; preserve work and reconcile remote facts before continuing`);
      throw primary;
    } finally {
      if (temporary) {
        try { await rm(temporary, { recursive: true, force: true }); }
        catch {
          if (primary instanceof Error) primary.message += '; temporary request cleanup also failed';
          else throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Request returned but temporary payload cleanup failed; reconcile before further writes');
        }
      }
    }
  }

  async list<T>(path: string): Promise<T[]> {
    const output = await run(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', '--paginate', '--slurp',
      `repos/${this.repository}/${path}${path.includes('?') ? '&' : '?'}per_page=100`], {
      cwd: this.cwd, timeoutMs: 30_000, label: 'GitHub paginated read',
    });
    let pages: unknown;
    try { pages = JSON.parse(output); } catch { /* Shape validation below. */ }
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new PreflightError('REMOTE_INVALID', 'Invalid paginated response');
    return pages.flat() as T[];
  }

  async comments(number: number) {
    const comments = await this.list<Comment>(`issues/${number}/comments`);
    if (!comments.every(comment => validComment(comment, this.repository, number))) throw new PreflightError('REMOTE_INVALID', 'Unexpected discussion response');
    return comments;
  }
  async comment(number: number, body: string) {
    const comment = await this.api<Comment>(`issues/${number}/comments`, 'POST', { body });
    if (!validComment(comment, this.repository, number) || comment.body !== body) {
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Comment write did not return the exact recorded question; reconcile remote discussion');
    }
    return comment;
  }
  async pull(number: number) {
    const pr = await this.api<PullRequest>(`pulls/${number}`);
    if (!validPull(pr, this.repository, true) || pr.number !== number) throw new PreflightError('REMOTE_INVALID', 'Unexpected PR response');
    return pr;
  }
  async pulls(head: string, base: string): Promise<PullRequest[]> {
    const owner = this.repository.split('/')[0];
    const found = await this.list<PullRequest>(`pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`);
    if (!found.every(pr => validPull(pr, this.repository))) throw new PreflightError('REMOTE_INVALID', 'Unexpected PR list response');
    return found.filter(pr => pr.head.ref === head && pr.base.ref === base
      && pr.head.repo?.full_name.toLowerCase() === this.repository.toLowerCase());
  }
  async createPull(head: string, base: string, title: string, body: string, draft = true): Promise<PullRequest> {
    const found = await this.pulls(head, base);
    if (found.length) throw new PreflightError('DELIVERY_EXISTS', 'Existing exact-branch PR needs reconciliation; do not create another');
    this.signal?.throwIfAborted();
    try {
      const created = await this.api<PullRequest>('pulls', 'POST', { head, base, title, body, draft });
      if (!validPull(created, this.repository)) throw new Error('PR creation returned no verifiable identity');
      const actual = await this.pull(created.number);
      if (actual.head.ref !== head || actual.base.ref !== base || actual.draft !== draft || actual.body !== body) {
        throw new Error('Created PR differs from expected delivery');
      }
      return actual;
    } catch (error) {
      if ((this.signal?.aborted && error === this.signal.reason)
        || (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED')) throw error;
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'PR write or its readback was not confirmed; preserve work and reconcile the exact head/base PR');
    }
  }

  async requireMergeStrategy(): Promise<void> {
    const repo = await this.api<{ allow_merge_commit?: unknown }>('');
    if (repo?.allow_merge_commit !== true) throw new PreflightError('MERGE_STRATEGY_UNSUPPORTED', 'Repository must permit explicit merge commits; do not substitute squash/rebase or bypass policy');
  }

  async ready(number: number): Promise<PullRequest> {
    this.signal?.throwIfAborted();
    try {
      await run(['gh', 'pr', 'ready', String(number), '--repo', this.repository], {
        cwd: this.cwd, timeoutMs: 30_000, label: 'Ticket PR ready',
      });
      const actual = await this.pull(number);
      if (actual.draft || actual.state !== 'open') throw new Error('Ready readback differs');
      return actual;
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Ticket PR ready outcome unconfirmed; reconcile the exact PR before further writes');
    }
  }

  async merge(number: number, H: string): Promise<string> {
    const result = await this.api<{ merged?: unknown; sha?: unknown }>(`pulls/${number}/merge`, 'PUT', {
      sha: H, merge_method: 'merge', commit_title: `Integrate verified Ticket PR #${number}`,
    });
    if (!result || result.merged !== true || typeof result.sha !== 'string' || !/^[a-f0-9]{40}$/.test(result.sha)) {
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Merge response does not confirm the exact applied commit; never repeat an uncertain merge');
    }
    return result.sha;
  }

  async closeIssue(number: number): Promise<void> {
    const written = await this.api<{ number?: unknown; state?: unknown; state_reason?: unknown; pull_request?: unknown }>(`issues/${number}`, 'PATCH', {
      state: 'closed', state_reason: 'completed',
    });
    if (written?.number !== number || written.state !== 'closed' || written.state_reason !== 'completed' || written.pull_request) {
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Issue closure response does not confirm the intended Ticket');
    }
    try {
      const actual = await this.api<{ number?: unknown; state?: unknown; state_reason?: unknown; pull_request?: unknown }>(`issues/${number}`);
      if (actual?.number !== number || actual.state !== 'closed' || actual.state_reason !== 'completed' || actual.pull_request) throw new Error('Closure readback differs');
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') throw error;
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Issue closure readback unavailable; distinguish applied integration from pending closure');
    }
  }
}
