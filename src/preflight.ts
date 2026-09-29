import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { checkAgentReadiness, instructionSnapshot } from './agents.ts';
import { PreflightError, readContract } from './contract.ts';
import { claimRepository } from './control.ts';
import { GitHub } from './github.ts';
import { readPlan } from './plan.ts';
import { digest, probeProject } from './probe.ts';
import { baseline } from './workspace.ts';
import { requireRemoteHead } from './ticket-workspace.ts';
import { type TicketResult } from './execution.ts';
import { type IntegrationFacts } from './integration.ts';
import { scheduleTickets } from './scheduler.ts';
import { ScopeGuard } from './scope.ts';
import { ActivitySlots } from './slots.ts';
import { ProjectResources } from './resources.ts';

export class FlowController {
  private status = 'idle';
  private task?: Promise<void>;
  private abort?: AbortController;
  private release?: () => Promise<void>;
  private unsafeProcess = false;
  private unknownRemote = false;
  private retainedResources = false;
  private stopReason?: unknown;
  private stopLevel = -1;
  private tickets: TicketResult[] = [];
  private integration?: IntegrationFacts;

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
    this.integration = undefined;
    this.unsafeProcess = false; this.unknownRemote = false; this.retainedResources = false; this.stopReason = undefined; this.stopLevel = -1;
    this.task = this.preflight(number, concurrency, ctx, signal, execute);
    try { await this.task; } finally { this.task = undefined; }
  }

  private async releaseOwnership(): Promise<void> {
    if (!this.release || this.unsafeProcess || this.unknownRemote || this.retainedResources || (this.integration && this.integration.phase !== 'delivered')) return;
    await this.release();
    this.release = undefined;
  }

  async pause(ctx: ExtensionContext, reason: string): Promise<void> {
    if (!this.task && !this.release) return;
    this.status = `stopping (${reason})`;
    ctx.ui.notify(`FLOW_PAUSING: ${reason}; waiting for commands to stop`, 'info');
    this.abort?.abort();
    await this.task;
    if (this.unsafeProcess || this.unknownRemote || this.retainedResources || (this.integration && this.integration.phase !== 'delivered')) {
      this.status = this.integration && this.integration.phase !== 'delivered'
        ? `integrated-unaccepted (${this.integration.phase}; ${this.integration.M}; ownership retained)`
        : 'stopping (unreconciled process or remote operation; ownership retained)';
      ctx.ui.notify(`FLOW_STOPPING: ${this.status}; manual reconciliation required; actual remote effects are preserved`, 'error');
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
      if (plan.spec.state !== 'open') throw new PreflightError('SPEC_CLOSED', 'The Spec must remain open throughout flow delivery; reconcile its lifecycle before starting');
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
        'These commands execute with your OS credentials, not a sandbox. Confirm this exact scope, independent-role configuration, probes, publishing and owned-probe cleanup. Starting authorizes Ticket implementation, commits, pushes, independent gates, Ticket PR creation/integration into the feature branch and verified Ticket closure. A total PR stays Draft. No main merge is allowed.\n' + JSON.stringify(snapshot, null, 2), { signal });
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
        const stop = (error: unknown, retainOwnership = false) => {
          const code = error instanceof PreflightError ? error.code : '';
          const level = code === 'PROCESS_UNQUIESCED' ? 4
            : ['REMOTE_RESULT_UNKNOWN', 'PUBLISH_UNRESOLVED'].includes(code) ? 3 : retainOwnership ? 2 : error === signal.reason ? 0 : 1;
          if (level > this.stopLevel) { this.stopReason = error; this.stopLevel = level; }
          this.unsafeProcess ||= code === 'PROCESS_UNQUIESCED';
          this.unknownRemote ||= ['REMOTE_RESULT_UNKNOWN', 'PUBLISH_UNRESOLVED'].includes(code);
          this.retainedResources ||= retainOwnership;
          this.abort?.abort();
        };
        const scope = new ScopeGuard({ plan, contract, instructions }, async () => {
          await requireRemoteHead(ctx.cwd, 'main', sha);
          const currentContract = await readContract(ctx.cwd);
          return { plan: await readPlan(github, number), contract: currentContract,
            instructions: await instructionSnapshot(ctx.cwd, currentContract) };
        }, signal, stop);
        const notify = (message: string) => ctx.ui.notify(message, 'info');
        const execution = { cwd: ctx.cwd, repository: github.repository, feature,
          initialMainSha: sha, plan, contract, approvedInstructions: instructions,
          scopeDigest: approvedDigest, ctx: { ...ctx, model: approvedModel }, signal, scope, stop,
          activities: new ActivitySlots(concurrency, stop, notify),
          resources: new ProjectResources(contract.resources.mode, stop, notify) };
        const outcome = await scheduleTickets(execution, result => {
          this.tickets = [...this.tickets.filter(ticket => ticket.number !== result.number), result];
          ctx.ui.notify(`FLOW_TICKET_STATE: ${JSON.stringify({ ticket: result.number, state: result.state, pr: result.pr?.number })}`, 'info');
        }, facts => {
          this.integration = facts;
          this.status = facts.phase === 'delivered' ? 'running' : `integrated-unaccepted (${facts.phase}; ${facts.M})`;
        });
        this.status = outcome === 'blocked' ? 'blocked (Tickets require decisions or verified dependencies)' : 'paused (final-acceptance-not-installed)';
      }
      ctx.ui.notify(`FLOW_STARTED: Spec #${number}; baseline ${sha}; ${this.status}`, 'info');
    } catch (caught) {
      const error = this.stopReason ?? caught;
      this.unsafeProcess ||= error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED';
      this.unknownRemote ||= error instanceof PreflightError && ['REMOTE_RESULT_UNKNOWN', 'PUBLISH_UNRESOLVED'].includes(error.code);
      this.status = this.integration && this.integration.phase !== 'delivered'
        ? `integrated-unaccepted (${this.integration.phase}; ${this.integration.M}; ownership retained)`
        : this.unsafeProcess || this.unknownRemote || this.retainedResources ? 'stopping (reconciliation required)' : signal.aborted && !this.stopReason ? 'paused (cancelled)' : started ? 'failed (work preserved; reconciliation required)' : 'idle (start refused)';
      ctx.ui.notify(error instanceof PreflightError
        ? `${error.code}: ${error.message}; ${started ? 'work preserved; no further dispatch or integration' : 'no dispatch'}`
        : signal.aborted ? 'FLOW_PAUSED: start cancelled; no late result can authorize dispatch'
        : 'PREFLIGHT_FAILED: unexpected local failure; inspect privately; no dispatch', 'error');
      await this.releaseOwnership();
    }
  }
}
