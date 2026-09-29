import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { FlowController } from './preflight.ts';

export default function implementFlow(pi: ExtensionAPI) {
  const flow = new FlowController();
  pi.registerCommand('flow', {
    description: 'Start a planned Spec: /flow start <issue> [--concurrency N]; /flow status',
    handler: async (args, ctx) => {
      if (args.trim() === 'status') return flow.show(ctx);
      const input = /^start ([1-9]\d*)(?: --concurrency ([1-9]\d*))?$/.exec(args.trim());
      if (!input) {
        ctx.ui.notify('Usage: /flow start <issue> [--concurrency N]; /flow status', 'error');
        return;
      }
      const number = Number(input[1]);
      const concurrency = Number(input[2] ?? 2);
      if (![number, concurrency].every(Number.isSafeInteger)) {
        ctx.ui.notify('INPUT_INVALID: Issue and concurrency must be positive safe integers', 'error');
        return;
      }
      await flow.start(number, concurrency, ctx);
    },
  });
  pi.on('session_before_switch', async (_event, ctx) => { await flow.pause(ctx, 'session change'); });
  pi.on('session_before_fork', async (_event, ctx) => { await flow.pause(ctx, 'session fork'); });
  pi.on('session_before_tree', async (_event, ctx) => { await flow.pause(ctx, 'session tree navigation'); });
  pi.on('session_shutdown', async (_event, ctx) => { await flow.pause(ctx, 'session shutdown/reload'); });
}
