import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export const names = ['real-openai-diamond', 'slot-release-and-local-block', 'exclusive-real-resource', 'latest-base-semantic-conflict', 'parallel-unknown-retains-cleanup'];
export const baselines = {
  'nanzhi84/pi-implement-flow-scheduling-acceptance': '5b409de584751530811f3e652de614389121c211',
  'nanzhi84/pi-implement-flow-exclusive-acceptance': '485b0ddfecbfed0fc6248fdad63454c792902f03',
};
const preserve = 'Preserve app.mjs, .pi/flow.json, AGENTS.md, publish.mjs, all existing assertions, and main. Create executable acceptance files before implementation. Each acceptance script must actually invoke the new CLI and assert its exact stdout and exit status, then output the strict passed/assertions JSON required by AGENTS.md. No framework or dependencies. Keep Spec open and total PR Draft.';
export function requests(scenario) {
  if (scenario === names[0]) return {
    A: `Add upper.mjs exporting upper(name), returning exactly HELLO, followed by one space, the name and ! then newline. node upper.mjs Ada emits exactly HELLO, Ada! followed by one newline; import must produce no stdout. Add acceptance/upper.mjs named upper-cli before implementation; also check another name and importing the function. ${preserve}`,
    B: `Add repeat.mjs exporting repeat(name,count), returning the original Hello greeting with newline repeated count times. node repeat.mjs Ada 2 emits exactly two Hello, Ada! lines. Count is a positive integer in this ticket; import must produce no stdout. Add acceptance/repeat.mjs named repeat-cli before implementation, also check count 1 and 3 and importing the function. ${preserve}`,
    C: `Use the delivered A upper(name) and B repeat(name,count) exports. Add combined.mjs CLI: node combined.mjs Ada 2 emits exactly HELLO, Ada! newline then two Hello, Ada! newline lines. Add acceptance/combined.mjs named combined-cli before implementation, testing Ada/2 and Bea/1. Do not duplicate upstream implementations. ${preserve}`,
  };
  if (scenario === names[1]) return {
    A: 'In fixture.mjs accept branch, before the existing Ada check, add a real CLI assertion that accepted name " Ada " preserves surrounding spaces. Preserve every original check and output envelope. Only fixture.mjs changes; this is additive coverage for existing behavior, not a changed acceptance contract.',
    B: 'In fixture.mjs accept branch, immediately before the final process.stdout.write of the acceptance envelope, add a real CLI assertion that accepted name "Zoë" preserves Unicode. Preserve every original check and output envelope. Only fixture.mjs changes; this is additive coverage for existing behavior. A and B have no declared business dependency despite editing the same file.',
    D: 'The stakeholder has not chosen whether a new formatter should use dashes or underscores. This intentionally unresolved requirement is a local blocked case: ask which is required before any edit and return blocked. Do not guess, modify files, or create a PR.',
    E: 'After D is delivered, implement its chosen formatter. No choice has yet been approved. Never start before D has verified delivery.',
  };
  if (scenario === names[4]) return {
    A: 'Add alpha.mjs printing exactly alpha followed by newline. Only alpha.mjs may change. This isolated fault fixture will lose confirmation of an applied Ticket push; preserve all effects and stop without replay.',
    B: 'Add beta.mjs printing exactly beta followed by newline. Only beta.mjs may change. Its model transport will stay pending while the other Ticket gets an unknown write. Cancellation and cleanup must precede any later delivery; no late model result authorizes a write.',
  };
  if (scenario === names[2]) return {
    A: 'Add alpha.mjs: node alpha.mjs prints exactly alpha followed by newline. Only alpha.mjs may change. Existing behavior and tests remain intact. This synthetic boundary checks exclusive shared project resources during implementation and independent gates.',
    B: 'Add beta.mjs: node beta.mjs prints exactly beta followed by newline. Only beta.mjs may change. Existing behavior and tests remain intact. This synthetic boundary checks exclusive shared project resources during implementation and independent gates.',
  };
  return {
    A: 'Add policy.json with exactly {"prefix":"HELLO"} and acceptance/policy.mjs that reads it and asserts the prefix. This synthetic deliberate composition-conflict fixture approves this Ticket independently. Preserve original commands and greeting. Do not edit the other Ticket.',
    B: 'Add semantic.mjs CLI that uses policy.json prefix if present, else Hello, and prints that prefix followed by comma-space, supplied name, exclamation and newline. Add acceptance/semantic.mjs before implementation, asserting node semantic.mjs Ada is exactly Hello, Ada! newline. This deliberate composition-conflict fixture will become inconsistent when A policy is integrated; the gate must expose that failure rather than weakening this assertion. Preserve commands and other files.',
  };
}
const write = (path, content) => ({ name: 'write', arguments: { path, content } });
function cliAssertion(name, filename, expected) {
  return `import assert from 'node:assert/strict';\nimport {execFileSync} from 'node:child_process';\nassert.equal(execFileSync(process.execPath,[${JSON.stringify(filename)},'Ada'],{encoding:'utf8'}),${JSON.stringify(expected)});\nconsole.log(JSON.stringify({passed:true,assertions:[{name:${JSON.stringify(name)},passed:true}]}));\n`;
}
export async function fixedFiles(project, scenario) {
  if (scenario === names[1]) {
    const source = await readFile(join(project, 'fixture.mjs'), 'utf8');
    const a = source.replace("  const greeting = execFileSync", "  if (execFileSync(process.execPath, ['app.mjs', ' Ada '], { encoding: 'utf8' }) !== 'Hello,  Ada !\\n') throw new Error('surrounding-name-spaces');\n  const greeting = execFileSync");
    const b = source.replace("  process.stdout.write(JSON.stringify({ passed: true, assertions })", "  if (execFileSync(process.execPath, ['app.mjs', 'Zoë'], { encoding: 'utf8' }) !== 'Hello, Zoë!\\n') throw new Error('unicode-name');\n  process.stdout.write(JSON.stringify({ passed: true, assertions })");
    if (a === source || b === source) throw new Error('Known additive fixture baseline required');
    return { A: [write('fixture.mjs', a)], B: [write('fixture.mjs', b)] };
  }
  if ([names[2], names[4]].includes(scenario)) return { A: [write('alpha.mjs', "console.log('alpha');\n")], B: [write('beta.mjs', "console.log('beta');\n")] };
  return {
    A: [write('acceptance/policy.mjs', "import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nassert.equal(JSON.parse(readFileSync('policy.json','utf8')).prefix,'HELLO');\nconsole.log(JSON.stringify({passed:true,assertions:[{name:'policy-prefix',passed:true}]}));\n"), write('policy.json', '{"prefix":"HELLO"}\n')],
    B: [write('acceptance/semantic.mjs', cliAssertion('semantic-original', 'semantic.mjs', 'Hello, Ada!\n')), write('semantic.mjs', "import {existsSync,readFileSync} from 'node:fs';\nconst prefix=existsSync('policy.json')?JSON.parse(readFileSync('policy.json','utf8')).prefix:'Hello';\nconsole.log(`${prefix}, ${process.argv[2]}!`);\n")],
  };
}
