import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { repository } from '../acceptance-repository.mjs';

// The sole deterministic substitution in real-repair is its initial model
// transport. All tools, controller paths, repair/review calls and GitHub effects
// remain real; credentials and selected model configuration are untouched.
export default function repairModelBridge(pi) {
  const original = ModelRuntime.prototype.streamSimple;
  let configuration;
  const calls = [];
  pi.registerCommand('fixture-repair-model', { handler: async (source, ctx) => {
    if (configuration || repository !== 'nanzhi84/pi-implement-flow-repair-acceptance') throw new Error('Unsafe repair fixture');
    const data = JSON.parse(source);
    if (data.repository !== repository || ctx.model?.provider !== 'openai' || ctx.model?.id !== 'gpt-6-astra'
      || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(data.provider?.baseUrl)
      || data.provider?.apiKey !== 'synthetic-local-only') throw new Error('Invalid controlled initial transport');
    configuration = data;
    ModelRuntime.prototype.streamSimple = function (model, context, options) {
      const implementation = context.tools?.some(tool => tool.name === 'write');
      const messages = context.messages.filter(message => message.role === 'user');
      const repair = messages.some(message => JSON.stringify(message.content).includes('repair-candidate'));
      const fixed = implementation && !repair;
      calls.push({ role: implementation ? 'implementation' : 'review', repair, provider: fixed ? 'flow-repair-fixture' : model.provider, id: fixed ? 'fixed' : model.id });
      if (fixed) {
        if (!this.getModel('flow-repair-fixture', 'fixed')) this.registerProvider('flow-repair-fixture', configuration.provider);
        return original.call(this, this.getModel('flow-repair-fixture', 'fixed'), context, options);
      }
      return original.call(this, model, context, options);
    };
  } });
  pi.registerCommand('fixture-repair-model-status', { handler: async (_source, ctx) => {
    ctx.ui.notify(`REPAIR_MODEL_OBSERVER: ${JSON.stringify(calls)}`, 'info');
  } });
  pi.on('session_shutdown', async () => { ModelRuntime.prototype.streamSimple = original; });
}
