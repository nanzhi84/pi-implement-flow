import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// RPC has no built-in /reload or /tree command. This acceptance-only bridge uses
// the actual pi command-context operations; it does not emit/fake lifecycle events.
export default function lifecycleBridge(pi: ExtensionAPI) {
  pi.registerCommand('fixture-seed', {
    handler: async (_args, ctx) => {
      await ctx.newSession({ setup: async manager => {
        manager.appendMessage({ role: 'user', content: 'synthetic first entry', timestamp: 1 });
        manager.appendMessage({ role: 'user', content: 'synthetic second entry', timestamp: 2 });
      } });
    },
  });
  pi.registerCommand('fixture-reload', { handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand('fixture-fork', { handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user');
    if (!entry) throw new Error('Synthetic user entry required');
    await ctx.fork(entry.id);
  } });
  pi.registerCommand('fixture-tree', { handler: async (_args, ctx) => {
    const entry = ctx.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user');
    if (!entry) throw new Error('Synthetic user entry required');
    await ctx.navigateTree(entry.id, { summarize: false });
  } });
}
