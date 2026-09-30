import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { repository } from '../acceptance-repository.mjs';

// The sole deterministic substitution in real-repair is its initial model
// transport. All tools, controller paths, repair/review calls and GitHub effects
// remain real; credentials and selected model configuration are untouched.
export default function repairModelBridge(pi) {
  const original = ModelRuntime.prototype.streamSimple;
  const originalCreate = ModelRuntime.create;
  let configuration;
  let runtimeCreations = 0;
  let ui; let notify;
  const calls = [];
  pi.registerCommand('fixture-repair-model', { handler: async (source, ctx) => {
    if (configuration || repository !== 'nanzhi84/pi-implement-flow-repair-acceptance') throw new Error('Unsafe repair fixture');
    const data = JSON.parse(source);
    if (data.repository !== repository || ctx.model?.provider !== 'openai' || ctx.model?.id !== 'gpt-6-astra'
      || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(data.provider?.baseUrl)
      || data.provider?.apiKey !== 'synthetic-local-only') throw new Error('Invalid controlled initial transport');
    configuration = data;
    ModelRuntime.create = async function (...args) {
      const runtime = await originalCreate.apply(this, args);
      runtimeCreations += 1;
      return runtime;
    };
    ui = ctx.ui; notify = ui.notify;
    ui.notify = (message, ...args) => {
      if (String(message).startsWith('AGENT_STARTED: ') && !runtimeCreations) {
        throw new Error('Initial defect transport is not bound to the actual host runtime; no implementation dispatch');
      }
      return notify.call(ui, message, ...args);
    };
    ModelRuntime.prototype.streamSimple = function (model, context, options) {
      const toolNames = getCurrentTools(context.messages).map(tool => tool.name);
      if (!toolNames.includes('read')) throw new Error('Only an explicitly tooled role may reach the fixture model boundary');
      const implementation = toolNames.includes('write');
      const messages = context.messages.filter(message => message.role === 'user');
      const repair = messages.some(message => JSON.stringify(message.content).includes('repair-candidate'));
      const fixed = implementation && !repair;
      calls.push({ role: implementation ? 'implementation' : 'review', repair, toolNames, provider: fixed ? 'flow-repair-fixture' : model.provider, id: fixed ? 'fixed' : model.id });
      if (fixed) {
        if (!this.getModel('flow-repair-fixture', 'fixed')) this.registerProvider('flow-repair-fixture', configuration.provider);
        // A provider switch must not forward the selected provider's request
        // credentials. This mirrors the SDK's own cross-provider routing rule.
        const { apiKey, headers, env, ...rest } = options ?? {};
        return original.call(this, this.getModel('flow-repair-fixture', 'fixed'), context, { ...rest, apiKey: 'synthetic-local-only' });
      }
      return original.call(this, model, context, options);
    };
  } });
  pi.registerCommand('fixture-repair-model-status', { handler: async (_source, ctx) => {
    ctx.ui.notify(`REPAIR_MODEL_OBSERVER: ${JSON.stringify(calls)}`, 'info');
  } });
  pi.on('session_shutdown', async () => {
    ModelRuntime.prototype.streamSimple = original; ModelRuntime.create = originalCreate;
    if (ui) ui.notify = notify;
  });
}
