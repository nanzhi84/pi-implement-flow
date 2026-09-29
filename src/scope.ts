import { PreflightError, type Contract } from './contract.ts';
import type { ApprovedInstruction } from './evidence-context.ts';
import { planScope, type Plan } from './plan.ts';
import { digest } from './probe.ts';
import { SerialControl } from './slots.ts';

interface ScopeSnapshot { plan: Plan; contract: Contract; instructions: readonly ApprovedInstruction[]; }
export class ScopeGuard {
  private readonly serial = new SerialControl();
  private readonly closed = new Set<number>();
  constructor(private readonly approved: ScopeSnapshot, private readonly read: () => Promise<ScopeSnapshot>,
    private readonly signal: AbortSignal, private readonly stop: (error: unknown) => void) {}
  private async check(): Promise<void> {
    this.signal.throwIfAborted();
    const current = await this.read();
    const { plan, contract, instructions } = this.approved;
    if (current.plan.spec.state !== plan.spec.state || current.plan.tickets.some(ticket => {
      const original = plan.tickets.find(item => item.issue.number === ticket.issue.number);
      return ticket.issue.state !== (this.closed.has(ticket.issue.number) ? 'closed' : original?.issue.state);
    }) || digest(planScope(current.plan)) !== digest(planScope(plan))
      || digest(current.contract) !== digest(contract) || digest(current.instructions) !== digest(instructions)) {
      throw new PreflightError('SCOPE_CHANGED', 'Approved planning, lifecycle, contract or instructions changed outside confirmed controller closure');
    }
    this.signal.throwIfAborted();
  }
  async assert(): Promise<void> {
    return this.serial.run(this.signal, async () => {
      try { await this.check(); } catch (error) { this.stop(error); throw error; }
    });
  }
  async confirmClosure(ticket: number, closeAndVerify: () => Promise<void>): Promise<void> {
    return this.serial.run(this.signal, async () => {
      try {
        await this.check();
        if (this.closed.has(ticket) || !this.approved.plan.tickets.some(item => item.issue.number === ticket && item.issue.state === 'open')) {
          throw new PreflightError('CLOSURE_INVALID', 'Only an approved open Ticket can be closed once by this controller');
        }
        await closeAndVerify(); // Includes PATCH response and completed readback; no recursive assert.
        this.closed.add(ticket); // Record a confirmed side effect even if cancellation arrived meanwhile.
      } catch (error) { this.stop(error); throw error; }
    });
  }
}
