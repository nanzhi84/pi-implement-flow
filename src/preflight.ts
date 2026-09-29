import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { checkAgentReadiness, instructionSnapshot } from './agents.ts';
import { PreflightError, readContract } from './contract.ts';
import { claimRepository } from './control.ts';
import { GitHub } from './github.ts';
import { readPlan } from './plan.ts';
import { digest, probeProject } from './probe.ts';
import { baseline } from './workspace.ts';
import { executeFirstTicket, type TicketResult } from './execution.ts';

export class FlowController {
  private status = 'idle';
  private task?: Promise<void>;
  private abort?: AbortController;
  private release?: () => Promise<void>;
  private unsafeProcess = false;
  private unknownRemote = false;
  private tickets: TicketResult[] = [];

  show(ctx: ExtensionContext): void {
    ctx.ui.notify(`flow: ${this.status}${this.tickets.map(ticket => `\nTicket #${ticket.number}: ${ticket.state}${ticket.pr ? ` ${ticket.pr.html_url}` : ''}`).join('')}`, 'info');
  }

  async start(number: number, concurrency: number, ctx: ExtensionCommandContext, execute = true): Promise<void> {
    if (this.task || this.release) {
      ctx.ui.notify('FLOW_OWNED: this controller already owns a flow or is stopping', 'error');
      return;
    }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.status = 'preflighting';
    this.tickets = [];
    this.task = this.preflight(number, concurrency, ctx, signal, execute);
    try { await this.task; } finally { this.task = undefined; }
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.release || this.unsafeProcess || this.unknownRemote) return;
    await this.release();
    this.release = undefined;
  }

  async pause(ctx: ExtensionContext, reason: string): Promise<void> {
    if (!this.task && !this.release) return;
    this.status = `stopping (${reason})`;
    ctx.ui.notify(`FLOW_PAUSING: ${reason}; waiting for commands to stop`, 'info');
    this.abort?.abort();
    await this.task;
    if (this.unsafeProcess || this.unknownRemote) {
      this.status = 'stopping (unreconciled process or remote operation; ownership retained)';
      ctx.ui.notify('FLOW_STOPPING: process or remote outcome unverified; manual reconciliation required; ownership retained', 'error');
      return;
    }
    await this.releaseOwnership();
    this.status = `paused (${reason}; explicit start/reconciliation required)`;
    ctx.ui.notify(`FLOW_PAUSED: ${reason}; no side effects are rolled back`, 'info');
  }

  private async preflight(number: number, concurrency: number, ctx: ExtensionCommandContext, signal: AbortSignal, execute: boolean): Promise<void> {
    let started = false;
    try {
      await readContract(ctx.cwd);
      const github = await GitHub.fromOrigin(ctx.cwd);
      this.release = await claimRepository(github.identity);
      signal.throwIfAborted();
      const feature = `flow/spec-${number}`;
      const plan = await readPlan(github, number);
      ctx.ui.notify(`PLAN_READ: Spec #${number}; Tickets ${plan.tickets.map(ticket => `#${ticket.issue.number}`).join(', ')}; concurrency ${concurrency}`, 'info');
      const edges = plan.tickets.filter(ticket => ticket.dependencies.length).map(ticket =>
        `#${ticket.issue.number} <- ${ticket.dependencies.map(dependency => `#${dependency}`).join(', ')}`);
      ctx.ui.notify(`DEPENDENCIES: ${edges.join('; ') || 'none'}; closed Issues are not proof of integration`, 'info');
      await github.inspectProtection(feature);
      signal.throwIfAborted();
      const sha = await baseline(ctx.cwd, feature, signal);
      const contract = await readContract(ctx.cwd);
      const instructions = await instructionSnapshot(ctx.cwd, contract);
      const approvedModel = ctx.model;
      const model = approvedModel ? { provider: approvedModel.provider, id: approvedModel.id } : null;
      const snapshot = { sha, repository: github.repository, feature, plan, concurrency, contract, instructions, model, execute };
      const approvedDigest = digest(snapshot);
      if (!ctx.hasUI) throw new PreflightError('CONFIRMATION_REQUIRED', 'Start requires an interactive pi or RPC confirmation');
      const accepted = await ctx.ui.confirm('Confirm flow scope and trusted project probes',
        'These commands execute with your OS credentials, not a sandbox. Confirm this exact scope, independent-role configuration, probes, publishing and owned-probe cleanup. Starting also authorizes Ticket implementation, commits, pushes and PR creation. No main merge is allowed.\n' + JSON.stringify(snapshot, null, 2), { signal });
      signal.throwIfAborted();
      if (!accepted) {
        this.status = 'idle';
        ctx.ui.notify('CANCELLED: no project command, publication or dispatch', 'info');
        await this.releaseOwnership();
        return;
      }
      const verifySnapshot = async () => {
        const currentContract = await readContract(ctx.cwd);
        const current = { ...snapshot,
          sha: await baseline(ctx.cwd, feature, signal), plan: await readPlan(github, number),
          contract: currentContract, instructions: await instructionSnapshot(ctx.cwd, currentContract),
          model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
        };
        signal.throwIfAborted();
        if (digest(current) !== approvedDigest) throw new PreflightError('SCOPE_CHANGED', 'Planning, project, model or contract changed after confirmation; old approval cannot authorize new content');
        await github.inspectProtection(feature);
        signal.throwIfAborted();
      };
      await verifySnapshot();
      await checkAgentReadiness(ctx.cwd, contract, ctx, signal);
      ctx.ui.notify('REVIEW_READY: independent SDK contexts and explicit tools verified; no native approval required by supported policy; no credential hard isolation', 'info');
      const url = await probeProject(ctx.cwd, github.repository, sha, approvedDigest, contract, signal);
      await verifySnapshot();
      ctx.ui.notify(`EVIDENCE_URL: ${url}`, 'info');
      started = true;
      if (!execute) {
        this.status = 'paused (preflight-only)';
      } else {
        this.status = 'running';
        // Once our feature exists, baseline() must no longer be used as a fresh-start check.
        const assertScope = async () => {
          signal.throwIfAborted();
          const currentContract = await readContract(ctx.cwd);
          const currentPlan = await readPlan(github, number);
          if (digest(currentContract) !== digest(contract) || digest(currentPlan) !== digest(plan)
            || digest(await instructionSnapshot(ctx.cwd, currentContract)) !== digest(instructions)) {
            throw new PreflightError('SCOPE_CHANGED', 'Scope or contract changed; prior approval cannot authorize delivery');
          }
          signal.throwIfAborted();
        };
        const result = await executeFirstTicket({ cwd: ctx.cwd, repository: github.repository, feature,
          base: sha, plan, contract, scopeDigest: approvedDigest, ctx: { ...ctx, model: approvedModel }, signal, assertScope });
        this.tickets = [result];
        this.status = result.state === 'blocked' ? 'blocked (Ticket requires a decision)' : 'paused (gates-not-installed)';
      }
      ctx.ui.notify(`FLOW_STARTED: Spec #${number}; baseline ${sha}; ${this.status}`, 'info');
    } catch (error) {
      this.unsafeProcess = error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED';
      this.unknownRemote = error instanceof PreflightError && ['REMOTE_RESULT_UNKNOWN', 'PUBLISH_UNRESOLVED'].includes(error.code);
      this.status = this.unsafeProcess || this.unknownRemote ? 'stopping (reconciliation required)' : signal.aborted ? 'paused (cancelled)' : started ? 'failed (work preserved; reconciliation required)' : 'idle (start refused)';
      ctx.ui.notify(error instanceof PreflightError
        ? `${error.code}: ${error.message}; ${started ? 'work preserved; no further dispatch or integration' : 'no dispatch'}`
        : signal.aborted ? 'FLOW_PAUSED: start cancelled; no late result can authorize dispatch'
        : 'PREFLIGHT_FAILED: unexpected local failure; inspect privately; no dispatch', 'error');
      await this.releaseOwnership();
    }
  }
}
