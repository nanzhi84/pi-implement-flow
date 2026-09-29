import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreflightError } from './contract.ts';
import { run } from './process.ts';
import { classifyFailure } from './failure.ts';
import { remoteHead } from './remote-git.ts';
import { cannotReconcile, unknownWrite, RemoteCleanupFailure, RemoteLifecycleFailure } from './remote-error.ts';

export interface PullRequest {
  number: number; html_url: string; state: 'open' | 'closed'; draft: boolean; body: string; title: string;
  user: { id: number; login: string };
  merged: boolean; merge_commit_sha: string | null; mergeable: boolean | null;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
}
export interface Comment { id: number; html_url: string; body: string; user: { id: number; login: string }; }
export interface RemoteIssue {
  id: number; number: number; html_url: string; title: string; body: string; state: 'open' | 'closed';
  state_reason: string | null; user: { id: number }; pull_request?: unknown;
}
function validIssue(value: unknown, repository: string): value is RemoteIssue {
  if (!value || typeof value !== 'object') return false;
  const item = value as RemoteIssue;
  return Number.isSafeInteger(item.id) && item.id > 0 && Number.isSafeInteger(item.number) && item.number > 0
    && item.html_url === `https://github.com/${repository}/issues/${item.number}` && !item.pull_request
    && ['open', 'closed'].includes(item.state) && typeof item.title === 'string' && typeof item.body === 'string'
    && Number.isSafeInteger(item.user?.id) && item.user.id > 0;
}
function validComment(value: unknown, repository: string, number: number): value is Comment {
  if (!value || typeof value !== 'object') return false;
  const item = value as Comment;
  return Number.isSafeInteger(item.id) && item.id > 0 && typeof item.body === 'string'
    && [`https://github.com/${repository}/issues/${number}#issuecomment-${item.id}`,
      `https://github.com/${repository}/pull/${number}#issuecomment-${item.id}`].includes(item.html_url)
    && typeof item.user?.login === 'string' && Number.isSafeInteger(item.user.id) && item.user.id > 0;
}
function validPull(value: unknown, repository: string, details = false): value is PullRequest {
  if (!value || typeof value !== 'object') return false;
  const pr = value as PullRequest;
  return Number.isSafeInteger(pr.number) && pr.number > 0
    && pr.html_url === `https://github.com/${repository}/pull/${pr.number}`
    && ['open', 'closed'].includes(pr.state) && typeof pr.draft === 'boolean' && typeof pr.body === 'string' && typeof pr.title === 'string'
    && Number.isSafeInteger(pr.user?.id) && pr.user.id > 0
    && [pr.head, pr.base].every(ref => ref && typeof ref.ref === 'string' && /^[a-f0-9]{40}$/.test(ref.sha)
      && ref.repo?.full_name?.toLowerCase() === repository.toLowerCase())
    && (!details || (typeof pr.merged === 'boolean'
      && (pr.mergeable === null || typeof pr.mergeable === 'boolean')
      && (pr.merge_commit_sha === null || /^[a-f0-9]{40}$/.test(pr.merge_commit_sha))));
}

// Each write is one request. Failure is unknown, never an invitation to retry.
// Temporary request payloads are removed and are not an execution ledger.
export class Remote {
  private actorId?: Promise<number>;
  constructor(readonly cwd: string, readonly repository: string, private readonly signal?: AbortSignal) {}

  private actor(): Promise<number> {
    return this.actorId ??= (async () => {
      try {
        const value = JSON.parse(await run(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', 'user'], {
          cwd: this.cwd, timeoutMs: 30_000, label: 'GitHub actor identity', operation: 'github-read',
        }));
        if (!Number.isSafeInteger(value?.id) || value.id <= 0) throw new Error('Invalid actor');
        return value.id as number;
      } catch (error) {
        cannotReconcile(error, this.signal);
        throw new PreflightError('REMOTE_READ_FAILED', 'Cannot verify authenticated actor identity', error instanceof PreflightError ? error.detail : undefined);
      }
    })();
  }

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
      const output = await run(args, { cwd: this.cwd, timeoutMs: 30_000, label: `GitHub ${method}`,
        operation: method === 'GET' ? 'github-read' : 'github-write' });
      return output.trim() ? JSON.parse(output) as T : undefined as T;
    } catch (error) {
      primary = !sent && this.signal?.aborted ? this.signal.reason
        : error instanceof PreflightError && (error.code === 'PROCESS_UNQUIESCED'
          || (method === 'GET' && error.code === 'COMMAND_ORPHANED')) ? error
        : method === 'GET' ? new PreflightError('REMOTE_READ_FAILED', 'GitHub read could not be confirmed; preserve work and diagnose', error instanceof PreflightError ? error.detail : undefined)
        : !sent ? new PreflightError('REMOTE_NOT_SENT', 'Local request preparation failed before the GitHub command started; no automatic replay',
          { ...classifyFailure('github-write', error), commandStart: 'not-started' })
        : unknownWrite(error, 'GitHub write could not be confirmed; preserve work and reconcile its exact target', true);
      throw primary;
    } finally {
      if (temporary) {
        try { await rm(temporary, { recursive: true, force: true }); }
        catch {
          if (primary instanceof RemoteLifecycleFailure
            || (primary instanceof PreflightError && ['PROCESS_UNQUIESCED', 'COMMAND_ORPHANED'].includes(primary.code))) throw primary;
          throw new RemoteCleanupFailure(primary);
        }
      }
    }
  }

  async list<T>(path: string): Promise<T[]> {
    const output = await run(['gh', 'api', '--hostname', 'github.com', '--method', 'GET', '--paginate', '--slurp',
      `repos/${this.repository}/${path}${path.includes('?') ? '&' : '?'}per_page=100`], {
      cwd: this.cwd, timeoutMs: 30_000, label: 'GitHub paginated read', operation: 'github-read',
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
    const actor = await this.actor();
    const before = new Set((await this.comments(number)).map(item => item.id));
    let failure: unknown;
    try {
      const comment = await this.api<Comment>(`issues/${number}/comments`, 'POST', { body });
      if (validComment(comment, this.repository, number) && comment.body === body && comment.user.id === actor && !before.has(comment.id)) return comment;
    } catch (error) { cannotReconcile(error, this.signal, true); failure = error; }
    try {
      const found = (await this.comments(number)).filter(item => !before.has(item.id) && item.body === body && item.user.id === actor);
      if (found.length === 1) return found[0]!;
    } catch (error) { cannotReconcile(error, this.signal, true); failure ??= error; }
    throw unknownWrite(failure, 'Comment identity remains unknown; exact thread/body/actor and newly observed ID did not identify one result; no duplicate comment');
  }
  async issue(number: number): Promise<RemoteIssue> {
    const result = await this.api<RemoteIssue>(`issues/${number}`);
    if (!validIssue(result, this.repository) || result.number !== number) {
      throw new PreflightError('REMOTE_INVALID', 'Expected the exact Issue in this repository');
    }
    return result;
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
    const H = await remoteHead(this.cwd, head);
    const actor = await this.actor();
    if (!H) throw new PreflightError('REMOTE_DRIFT', 'The expected PR branch is absent before creation');
    const matches = (pr: PullRequest) => pr.head.ref === head && pr.base.ref === base && pr.head.sha === H
      && pr.draft === draft && pr.body === body && pr.title === title && pr.user.id === actor && pr.state === 'open' && !pr.merged;
    const found = await this.pulls(head, base);
    if (found.length) {
      if (found.length === 1) { const actual = await this.pull(found[0]!.number); if (matches(actual)) return actual; }
      throw new PreflightError('DELIVERY_EXISTS', 'Existing exact-branch PR differs from the expected delivery; preserve it');
    }
    this.signal?.throwIfAborted();
    let failure: unknown;
    try {
      const created = await this.api<PullRequest>('pulls', 'POST', { head, base, title, body, draft });
      if (!validPull(created, this.repository)) throw new Error('PR creation returned no verifiable identity');
      const actual = await this.pull(created.number);
      if (matches(actual)) return actual;
    } catch (error) {
      if (this.signal?.aborted && error === this.signal.reason) throw error;
      cannotReconcile(error, this.signal, true); failure = error;
    }
    try {
      const candidates = await this.pulls(head, base);
      if (candidates.length === 1) { const actual = await this.pull(candidates[0]!.number); if (matches(actual)) return actual; }
    } catch (error) { cannotReconcile(error, this.signal, true); failure ??= error; }
    throw unknownWrite(failure, 'Exact PR head/base/SHA/body/actor could not be confirmed; absence is not proof that creation failed; no duplicate PR');
  }

  async requireMergeStrategy(): Promise<void> {
    const repo = await this.api<{ allow_merge_commit?: unknown }>('');
    if (repo?.allow_merge_commit !== true) throw new PreflightError('MERGE_STRATEGY_UNSUPPORTED', 'Repository must permit explicit merge commits; do not substitute squash/rebase or bypass policy');
  }

  async ready(number: number): Promise<PullRequest> {
    const before = await this.pull(number);
    if (before.state !== 'open' || before.merged) throw new PreflightError('REMOTE_DRIFT', 'Only the exact open PR can become ready');
    if (!before.draft) return before;
    this.signal?.throwIfAborted();
    let failure: unknown;
    try {
      await run(['gh', 'pr', 'ready', String(number), '--repo', this.repository], {
        cwd: this.cwd, timeoutMs: 30_000, label: 'PR ready', operation: 'github-write',
      });
    } catch (error) { failure = unknownWrite(error, 'Ready result is unknown', true); cannotReconcile(failure, this.signal, true); }
    try {
      const actual = await this.pull(number);
      if (!actual.draft && actual.state === 'open' && !actual.merged && actual.head.sha === before.head.sha
        && actual.head.ref === before.head.ref && actual.base.ref === before.base.ref && actual.base.sha === before.base.sha
        && actual.body === before.body) return actual;
    } catch (error) { cannotReconcile(error, this.signal, true); failure ??= error; }
    throw unknownWrite(failure, 'Ready state at the expected PR version is unconfirmed; do not repeat ready or declare completion');
  }

  async merge(number: number, H: string, B: string): Promise<string> {
    const before = await this.pull(number);
    if (before.state !== 'open' || before.merged || before.draft || before.head.sha !== H || before.base.sha !== B) {
      throw new PreflightError('EVIDENCE_STALE', 'PR no longer matches the approved merge request');
    }
    let failure: unknown;
    try {
      const result = await this.api<{ merged?: unknown; sha?: unknown }>(`pulls/${number}/merge`, 'PUT', {
        sha: H, merge_method: 'merge', commit_title: `Integrate verified Ticket PR #${number}`,
      });
      if (result?.merged === true && typeof result.sha === 'string' && /^[a-f0-9]{40}$/.test(result.sha)) return result.sha;
    } catch (error) { cannotReconcile(error, this.signal, true); failure = error; }
    try {
      const actual = await this.pull(number);
      if (actual.merged && actual.state === 'closed' && actual.merge_commit_sha && actual.head.sha === H
        && actual.head.ref === before.head.ref && actual.base.ref === before.base.ref) {
        // This is the applied M, not integration approval. The caller records
        // it before checking ordered parents/tree/ref and running the M gate.
        return actual.merge_commit_sha;
      }
    } catch (error) { cannotReconcile(error, this.signal, true); failure ??= error; }
    throw unknownWrite(failure, 'The exact PR merge outcome remains unknown; keep ownership and inspect remote facts without replay');
  }

  async closeIssue(number: number): Promise<void> {
    const before = await this.issue(number);
    if (before.state === 'closed') {
      if (before.state_reason === 'completed') return;
      throw new PreflightError('REMOTE_DRIFT', 'Issue has a different existing closure conclusion');
    }
    let failure: unknown;
    try { await this.api(`issues/${number}`, 'PATCH', { state: 'closed', state_reason: 'completed' }); }
    catch (error) { cannotReconcile(error, this.signal, true); failure = error; }
    try {
      const actual = await this.issue(number);
      if (actual.id === before.id && actual.state === 'closed' && actual.state_reason === 'completed'
        && actual.title === before.title && actual.body === before.body) return;
    } catch (error) { cannotReconcile(error, this.signal, true); failure ??= error; }
    throw unknownWrite(failure, 'Issue closure could not be confirmed at the intended contents; preserve applied integration and pending closure');
  }

  async createChildIssue(parent: number, title: string, body: string): Promise<RemoteIssue> {
    const spec = await this.issue(parent);
    if (spec.state !== 'open') throw new PreflightError('REMOTE_DRIFT', 'Derived work requires an open parent Spec');
    const actor = await this.actor();
    const written = await this.api<RemoteIssue>('issues', 'POST', { title, body });
    // GitHub cannot atomically create and associate a child. If creation loses
    // its identity, do not search by title/body or create another Issue.
    if (!validIssue(written, this.repository) || written.title !== title || written.body !== body || written.user.id !== actor) {
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Created Issue identity is unresolved; retain it for human reconciliation without another create');
    }
    try {
      const actual = await this.issue(written.number);
      if (actual.id !== written.id || actual.title !== title || actual.body !== body || actual.state !== 'open' || actual.user.id !== actor) {
        throw new PreflightError('REMOTE_RESULT_UNKNOWN', 'Created Issue readback differs from the authorized derived work');
      }
      await this.associateChild(parent, actual);
      return actual;
    } catch (error) {
      // Creation has happened even when association never started. Preserve
      // its exact public identity and do not misreport the whole operation as unsent.
      if (error instanceof RemoteCleanupFailure || (error instanceof PreflightError
        && error.code === 'PROCESS_UNQUIESCED')) throw error;
      throw new PreflightError('REMOTE_RESULT_UNKNOWN', `Created Issue #${written.number} requires exact parent #${parent} reconciliation; do not create another Issue${error instanceof PreflightError && error.code === 'COMMAND_ORPHANED' ? '; COMMAND_ORPHANED' : ''}`,
        error instanceof PreflightError ? error.detail : undefined);
    }
  }

  async associateChild(parent: number, child: RemoteIssue): Promise<void> {
    if (!validIssue(child, this.repository) || child.number === parent) throw new PreflightError('REMOTE_INVALID', 'Expected an exact distinct child Issue');
    const spec = await this.issue(parent);
    const current = await this.issue(child.number);
    if (spec.state !== 'open' || current.id !== child.id || current.state !== 'open'
      || current.title !== child.title || current.body !== child.body) throw new PreflightError('REMOTE_DRIFT', 'Derived Issue or parent changed before native association');
    const confirmed = async () => {
      const children = await this.list<RemoteIssue>(`issues/${parent}/sub_issues`);
      if (!children.every(item => validIssue(item, this.repository))) throw new PreflightError('REMOTE_INVALID', 'Invalid native child list');
      const found = children.filter(item => item.id === child.id && item.number === child.number);
      if (found.length === 0) return false;
      if (found.length !== 1 || found[0]!.state !== 'open' || found[0]!.title !== child.title
        || found[0]!.body !== child.body || found[0]!.user.id !== child.user.id) {
        throw new PreflightError('REMOTE_DRIFT', 'Native association contains changed child contents; do not repeat association');
      }
      const actualParent = await this.api<RemoteIssue>(`issues/${child.number}/parent`);
      if (!validIssue(actualParent, this.repository) || actualParent.number !== parent || actualParent.id !== spec.id
        || actualParent.state !== 'open' || actualParent.title !== spec.title || actualParent.body !== spec.body) {
        throw new PreflightError('REMOTE_DRIFT', 'Native parent or its approved contents changed while associating the child');
      }
      return true;
    };
    if (await confirmed()) return;
    let failure: unknown;
    try { await this.api(`issues/${parent}/sub_issues`, 'POST', { sub_issue_id: child.id }); }
    catch (error) { cannotReconcile(error, this.signal, true); failure = error; }
    try { if (await confirmed()) return; }
    catch (error) { cannotReconcile(error, this.signal, true); failure ??= error; }
    throw unknownWrite(failure, 'Native parent/child association remains unconfirmed; retain both exact Issues without repeating association');
  }
}
