import { PreflightError } from './contract.ts';
import { submitTicket, type ExecutionInput, type Submission, type TicketResult } from './execution.ts';
import { integrateTicket, type Delivery, type IntegrationFacts } from './integration.ts';
import { git } from './process.ts';
import { SerialControl } from './slots.ts';
import { pushNew, requireRemoteHead } from './ticket-workspace.ts';
import { TicketPaused } from './candidate.ts';

export async function scheduleTickets(input: ExecutionInput, update: (ticket: TicketResult) => void,
  onFacts: (facts: IntegrationFacts) => void): Promise<'delivered' | 'blocked'> {
  const { cwd, signal, plan, ctx } = input;
  const integration = new SerialControl();
  const deliveries = new Map<number, Delivery>();
  const started = new Set<number>();
  const jobs = new Map<number, Promise<void>>();
  let acceptedFeatureHead = input.initialMainSha;
  let firstFailure: unknown;
  await input.scope.assert();
  await pushNew(cwd, acceptedFeatureHead, input.feature, signal);
  const launch = (ticket: typeof plan.tickets[number]) => {
    const number = ticket.issue.number;
    started.add(number);
    const job = (async () => {
      try {
        const dependencies = ticket.dependencies.map(item => deliveries.get(item)!);
        const base = await integration.run(signal, async () => {
          try {
            await input.scope.assert();
            await requireRemoteHead(cwd, input.feature, acceptedFeatureHead);
            await requireRemoteHead(cwd, 'main', input.initialMainSha);
            await git(cwd, ['fetch', '--no-write-fetch-head', 'origin', acceptedFeatureHead], signal);
            for (const dependency of dependencies) {
              const ancestry = (await git(cwd, ['merge-base', dependency.M, acceptedFeatureHead], signal)).trim();
              if (ancestry !== dependency.M) throw new PreflightError('DEPENDENCY_UNVERIFIED', 'Accepted feature does not contain a required verified delivery');
            }
            signal.throwIfAborted();
            ctx.ui.notify(`TICKET_STARTED: ${JSON.stringify({ ticket: number, startedFrom: acceptedFeatureHead, dependencies: dependencies.map(item => ({ ticket: item.ticket, M: item.M })) })}`, 'info');
            update({ number, state: 'implementing' });
            return acceptedFeatureHead;
          } catch (error) { input.stop(error); throw error; }
        });
        const result = await submitTicket(input, ticket, base, dependencies);
        signal.throwIfAborted();
        if (!('ownedWorkspace' in result)) { update(result); return; }
        const submission: Submission = result;
        update({ number, state: 'submitted', pr: result.pr });
        await integration.run(signal, async () => {
          try {
            update({ number, state: 'integrating', pr: result.pr });
            const delivery = await integrateTicket(input, submission, acceptedFeatureHead, facts => {
              onFacts(facts);
              update({ number, state: facts.phase === 'delivered' ? 'delivered' : 'integrated-unaccepted', pr: result.pr });
            });
            signal.throwIfAborted();
            acceptedFeatureHead = delivery.M;
            deliveries.set(number, delivery);
            update({ number, state: 'delivered', pr: delivery.pr });
          } catch (error) {
            if (error instanceof TicketPaused) { update({ number, state: 'blocked', pr: submission.pr }); return; }
            input.stop(error); throw error;
          }
        });
      } catch (error) {
        firstFailure ??= error;
        input.stop(error);
      } finally { jobs.delete(number); }
    })();
    jobs.set(number, job);
  };
  while (!signal.aborted) {
    for (const ticket of plan.tickets) {
      if (ticket.issue.state === 'open' && !started.has(ticket.issue.number)
        && ticket.dependencies.every(item => deliveries.has(item))) launch(ticket);
    }
    if (!jobs.size) break;
    await Promise.race(jobs.values());
  }
  // Cleanup and SDK disposal must converge before reporting paused/stopping.
  await Promise.all(jobs.values());
  if (firstFailure) throw firstFailure;
  signal.throwIfAborted();
  for (const ticket of plan.tickets) {
    if (!started.has(ticket.issue.number)) {
      update({ number: ticket.issue.number, state: 'blocked' });
      ctx.ui.notify(`DEPENDENCY_UNVERIFIED: Ticket #${ticket.issue.number}; no current verified dependency delivery; no inferred dependency or historical closure authority`, 'info');
    }
  }
  return deliveries.size === plan.tickets.length ? 'delivered' : 'blocked';
}
