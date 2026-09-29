import { PreflightError, readContract } from './contract.ts';
import { GitHub } from './github.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function implementFlow(pi: ExtensionAPI) {
  pi.registerCommand('flow', {
    description: 'Preflight a planned Spec: /flow start <issue>; /flow status',
    handler: async (args, ctx) => {
      if (args.trim() === 'status') {
        ctx.ui.notify('flow: idle', 'info');
        return;
      }
      if (!/^start [1-9]\d*$/.test(args.trim())) {
        ctx.ui.notify('Usage: /flow start <issue>; /flow status', 'error');
        return;
      }
      try {
        await readContract(ctx.cwd);
        const github = await GitHub.fromOrigin(ctx.cwd);
        const number = Number(args.trim().split(' ')[1]);
        if (!Number.isSafeInteger(number)) throw new PreflightError('INPUT_INVALID', 'Issue number exceeds supported integer range');
        const spec = await github.issue(number);
        const tickets = await github.children(number);
        // This is a read result, not approval or a validated execution plan.
        ctx.ui.notify(`PLAN_READ: Spec #${spec.number}; Tickets ${tickets.map(ticket => `#${ticket.number}`).join(', ')}; concurrency 2`, 'info');
        await github.inspectProtection(`flow/spec-${number}`);
      } catch (error) {
        ctx.ui.notify(error instanceof PreflightError
          ? `${error.code}: ${error.message}; no dispatch`
          : 'PREFLIGHT_FAILED: unexpected local failure; no dispatch', 'error');
      }
    },
  });
}
