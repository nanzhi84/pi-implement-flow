import { PreflightError, readContract } from './contract.ts';
import { GitHub } from './github.ts';
import { readPlan } from './plan.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function implementFlow(pi: ExtensionAPI) {
  pi.registerCommand('flow', {
    description: 'Preflight a planned Spec: /flow start <issue> [--concurrency N]; /flow status',
    handler: async (args, ctx) => {
      if (args.trim() === 'status') {
        ctx.ui.notify('flow: idle', 'info');
        return;
      }
      const input = /^start ([1-9]\d*)(?: --concurrency ([1-9]\d*))?$/.exec(args.trim());
      if (!input) {
        ctx.ui.notify('Usage: /flow start <issue> [--concurrency N]; /flow status', 'error');
        return;
      }
      try {
        const number = Number(input[1]);
        const concurrency = Number(input[2] ?? 2);
        if (![number, concurrency].every(Number.isSafeInteger)) throw new PreflightError('INPUT_INVALID', 'Issue number and concurrency must be positive safe integers');
        await readContract(ctx.cwd);
        const github = await GitHub.fromOrigin(ctx.cwd);
        const { spec, tickets } = await readPlan(github, number);
        // Structural validation is not approval or semantic completeness.
        ctx.ui.notify(`PLAN_READ: Spec #${spec.number}; Tickets ${tickets.map(ticket => `#${ticket.issue.number}`).join(', ')}; concurrency ${concurrency}`, 'info');
        const edges = tickets.filter(ticket => ticket.dependencies.length).map(ticket =>
          `#${ticket.issue.number} <- ${ticket.dependencies.map(dependency => `#${dependency}`).join(', ')}`);
        ctx.ui.notify(`DEPENDENCIES: ${edges.join('; ') || 'none'}; closed Issues are not proof of integration`, 'info');
        await github.inspectProtection(`flow/spec-${number}`);
      } catch (error) {
        ctx.ui.notify(error instanceof PreflightError
          ? `${error.code}: ${error.message}; no dispatch`
          : 'PREFLIGHT_FAILED: unexpected local failure; no dispatch', 'error');
      }
    },
  });
}
