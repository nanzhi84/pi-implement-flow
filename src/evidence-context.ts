import { createHash } from 'node:crypto';
import { PreflightError, type Contract } from './contract.ts';
import type { Plan, TicketPlan } from './plan.ts';

export interface ApprovedInstruction { path: string; content: string; }
const textLimit = 128 * 1024;
const contextLimit = 512 * 1024;

function invalid(): never {
  throw new PreflightError('EVIDENCE_CONTEXT_INVALID', 'Approved evidence context is missing, inconsistent or exceeds its safe size limits; no gate publication');
}

// Deterministic source excerpts, never model-authored requirements. Detection is
// deliberately explicit: arbitrary or encoded secrets cannot be recognized in general.
function safeText(source: string) {
  if (typeof source !== 'string' || source.includes('\0') || Buffer.byteLength(source) > textLimit) invalid();
  const redactions = new Map<string, number>();
  const mask = (kind: string) => {
    redactions.set(kind, (redactions.get(kind) ?? 0) + 1);
    return `[REDACTED:${kind}]`;
  };
  let text = source.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,
    () => mask('private-key'));
  text = text.replace(/^.*\b(?:authorization|api[-_ ]?key|(?:access|refresh|auth)[-_ ]?token|password|passwd|secret(?:[-_ ]?key)?|client[-_ ]?secret|credentials?)['"]?\s*[:=]\s*\S.*$/gim,
    () => mask('credential-assignment'));
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, () => mask('authorization'));
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    () => mask('credential-token'));
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>`"'()[\]{}]+/gi, value => {
    try {
      const url = new URL(value);
      if (url.protocol === 'file:') return mask('private-path');
      if (url.username || url.password) return mask('credential-url');
      const publicReference = url.protocol === 'https:' && url.host === 'github.com' && !url.search
        && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*$/.test(url.pathname)
        && /^#(?:issuecomment-[1-9]\d*|discussion_r[1-9]\d*)$/.test(url.hash);
      if (url.search || (url.hash && !publicReference)) return mask('url-parameters');
    } catch { return mask('unparseable-url'); }
    return value;
  });
  text = text.replace(/(?:\/(?:Users|home|private|tmp|var\/folders)\/|[A-Za-z]:\\Users\\|~\/)[^\s<>`"']+/g,
    () => mask('private-path'));
  text = text.replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    () => mask('email-address'));
  return { text, sha256: createHash('sha256').update(source).digest('hex'),
    redactions: [...redactions].map(([kind, count]) => ({ kind, count })) };
}

export function evidenceContext(repository: string, plan: Plan, ticket: TicketPlan, contract: Contract,
  instructions: readonly ApprovedInstruction[], scopeDigest: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{64}$/.test(scopeDigest)
    || !Array.isArray(instructions) || instructions.length > 64) invalid();
  const selected = [...new Set([...contract.agents.implementation.instructions, ...contract.agents.review.instructions])];
  if (instructions.length !== selected.length || instructions.some((item, index) => item.path !== selected[index])
    || !plan.tickets.includes(ticket)) invalid();
  const issue = (value: Plan['spec']) => ({ number: value.number,
    url: `https://github.com/${repository}/issues/${value.number}`,
    title: safeText(value.title), body: safeText(value.body) });
  const context = {
    schema: 1, source: 'controller-approved-snapshot', scopeDigest,
    spec: issue(plan.spec), ticket: { ...issue(ticket.issue), dependencies: [...ticket.dependencies] },
    approvedChanges: [],
    instructions: instructions.map(item => ({ path: safeText(item.path), content: safeText(item.content),
      roles: (['implementation', 'review'] as const).filter(role => contract.agents[role].instructions.includes(item.path)) })),
    contract: { source: '.pi/flow.json', snapshot: safeText(JSON.stringify(contract, null, 2)) },
    redactionBoundary: 'Text is the exact approved source except explicitly marked redactions; sha256 binds each original UTF-8 value. Redacted values are not included in readable text; original digests remain for binding, not confidentiality. Known credentials, authenticated/parameterized URLs, private paths and email addresses are masked; strict public GitHub comment references remain readable. Unknown or encoded secrets cannot be detected completely. No environment, auth files, raw sessions or process output are collected.',
  };
  if (Buffer.byteLength(JSON.stringify(context)) > contextLimit) invalid();
  return context;
}
