// Only explicitly provisioned synthetic repositories may receive fixture writes.
const allowed = new Set([
  'nanzhi84/pi-implement-flow-acceptance',
  'nanzhi84/pi-implement-flow-scheduling-acceptance',
  'nanzhi84/pi-implement-flow-repair-acceptance',
  'nanzhi84/pi-implement-flow-exclusive-acceptance',
  'nanzhi84/pi-implement-flow-reconciliation-acceptance',
]);
export const repository = process.env.FLOW_ACCEPTANCE_REPOSITORY ?? 'nanzhi84/pi-implement-flow-acceptance';
if (!allowed.has(repository)) throw new Error('FLOW_ACCEPTANCE_REPOSITORY must select an explicitly allowed synthetic repository');
export function assertRepositoryIdentity(value) {
  if (!value || value.full_name !== repository || !Number.isSafeInteger(value.id) || value.id <= 0) {
    throw new Error('Synthetic repository canonical identity differs from the selected fixture repository');
  }
}
