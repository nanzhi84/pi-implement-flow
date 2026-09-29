import { PreflightError } from './contract.ts';
import type { GitHub, Issue } from './github.ts';

export interface TicketPlan {
  issue: Issue;
  dependencies: number[];
}
export interface Plan {
  spec: Issue;
  tickets: TicketPlan[];
}

// Lifecycle state is observed separately from immutable requirements. A verified
// controller closure must not change the authorization for the original content.
// Excluding state never makes a closed Issue proof that its PR was integrated.
export function planScope(plan: Plan) {
  const content = ({ state: _state, ...issue }: Issue) => issue;
  return { spec: content(plan.spec), tickets: plan.tickets.map(ticket => ({
    issue: content(ticket.issue), dependencies: ticket.dependencies,
  })) };
}

// Deliberately a documented planning format, not an attempt to infer requirements
// from arbitrary prose. Semantic completeness still requires user confirmation.
function section(issue: Issue, names: string[]): string | undefined {
  const lines = issue.body.split(/\r?\n/);
  let active = false;
  let found = false;
  let fence: string | undefined;
  const body: string[] = [];
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker?.[1]) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2] ?? '')) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading) {
      active = names.includes(heading.toLowerCase());
      if (active && found) throw new PreflightError('PLAN_INCOMPLETE', `Issue #${issue.number}: duplicate planning section`);
      if (active) found = true;
    } else if (active) body.push(line);
  }
  return found ? body.join('\n').trim() : undefined;
}

function requireAcceptance(issue: Issue, spec: boolean): void {
  const acceptance = section(issue, spec ? ['acceptance criteria', 'testing decisions'] : ['acceptance criteria']);
  if (!acceptance || !/^\s*(?:[-*]|\d+\.)\s+\S/m.test(acceptance)) {
    throw new PreflightError('PLAN_INCOMPLETE', `Issue #${issue.number}: missing acceptance agreement; add an Acceptance criteria section with observable criteria`);
  }
  const scope = section(issue, spec ? ['problem statement'] : ['what to build']);
  if (!issue.title.trim() || !scope) {
    throw new PreflightError('PLAN_INCOMPLETE', `Issue #${issue.number}: missing ${spec ? 'Problem Statement' : 'What to build'} scope`);
  }
}

function declaredDependencies(ticket: Issue, repository: string): number[] | undefined {
  const declaration = section(ticket, ['blocked by']);
  if (declaration === undefined) return undefined;
  const fail = (): never => {
    throw new PreflightError('DEPENDENCY_INVALID', `Ticket #${ticket.number}: Blocked by must contain complete same-repository Issue references or None; no qualified shorthand, invalid numbers or ambiguous prose`);
  };
  const lines = declaration.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) fail();
  const dependencies = new Set<number>();
  for (const line of lines) {
    // Parenthetical display notes support existing tickets such as #2（讨论编号 1）.
    // Notes may not conceal another Issue reference or URL.
    let references = line.replace(/^[-*]\s+/, '');
    const note = /\s*(?:\([^()]*\)|（[^（）]*）)$/.exec(references);
    if (note) {
      if (/#|https?:\/\//i.test(note[0])) fail();
      references = references.slice(0, note.index).trim();
    }
    if (/^(?:none|无)$/i.test(references)) {
      if (lines.length !== 1) fail();
      return [];
    }
    // Consume every token, not merely valid-looking substrings of invalid input.
    for (const reference of references.split(/\s*[,，、]\s*|\s+/)) {
      const local = /^#([1-9]\d*)$/.exec(reference);
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(reference);
      if (!local && (!url || url[1]?.toLowerCase() !== repository.toLowerCase())) fail();
      const number = Number(local?.[1] ?? url?.[2]);
      if (!Number.isSafeInteger(number)) fail();
      dependencies.add(number);
    }
  }
  return [...dependencies].sort((a, b) => a - b);
}

function checkCycles(tickets: TicketPlan[]): void {
  const graph = new Map(tickets.map(ticket => [ticket.issue.number, ticket.dependencies]));
  const done = new Set<number>();
  const active = new Set<number>();
  const path: number[] = [];
  function visit(number: number): void {
    if (active.has(number)) {
      const cycle = [...path.slice(path.indexOf(number)), number].map(id => `#${id}`).join(' -> ');
      throw new PreflightError('DEPENDENCY_CYCLE', cycle);
    }
    if (done.has(number)) return;
    active.add(number); path.push(number);
    for (const dependency of graph.get(number) ?? []) visit(dependency);
    path.pop(); active.delete(number); done.add(number);
  }
  for (const ticket of tickets) visit(ticket.issue.number);
}

export async function readPlan(github: GitHub, number: number): Promise<Plan> {
  const spec = await github.issue(number);
  requireAcceptance(spec, true);
  const children = await github.children(number);
  if (!children.length) throw new PreflightError('PLAN_INCOMPLETE', `Spec #${number}: no native direct child Tickets`);
  const repositoryUrl = `https://api.github.com/repos/${github.repository}`.toLowerCase();
  const ids = new Set(children.map(child => child.number));
  if (ids.size !== children.length || children.some(child => child.repository.toLowerCase() !== repositoryUrl)) {
    throw new PreflightError('PLAN_INVALID', 'Direct child Tickets must be unique Issues in the selected repository');
  }
  const tickets: TicketPlan[] = [];
  for (const child of children) {
    requireAcceptance(child, false);
    const declared = declaredDependencies(child, github.repository);
    const native = await github.blockers(child.number);
    if (native.some(dependency => dependency.repository.toLowerCase() !== repositoryUrl)) {
      throw new PreflightError('DEPENDENCY_INVALID', `Ticket #${child.number}: native dependency belongs to another repository`);
    }
    const nativeIds = [...new Set(native.map(dependency => dependency.number))].sort((a, b) => a - b);
    if (nativeIds.length && declared && nativeIds.join(',') !== declared.join(',')) {
      throw new PreflightError('DEPENDENCY_INVALID', `Ticket #${child.number}: native dependencies disagree with Blocked by; reconcile planning before starting`);
    }
    if (!nativeIds.length && declared === undefined) {
      throw new PreflightError('PLAN_INCOMPLETE', `Ticket #${child.number}: declare Blocked by: None or explicit dependencies`);
    }
    const dependencies = nativeIds.length ? nativeIds : declared ?? [];
    for (const dependency of dependencies) {
      if (!ids.has(dependency)) throw new PreflightError('DEPENDENCY_INVALID', `Ticket #${child.number}: #${dependency} is not a direct child of Spec #${number}`);
    }
    // Closed is not equivalent to integrated. Delivery verification is a later gate.
    tickets.push({ issue: child, dependencies });
  }
  checkCycles(tickets);
  return { spec, tickets };
}
