import { PreflightError } from './contract.ts';

export function unknownWrite(error: unknown, message: string, writeCommandFailed = false): PreflightError {
  if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') return error;
  if (error instanceof RemoteLifecycleFailure) return error;
  if (error instanceof PreflightError && error.code === 'COMMAND_ORPHANED') return new RemoteLifecycleFailure(error);
  const detail = error instanceof PreflightError ? error.detail : undefined;
  if (writeCommandFailed && detail?.commandStart === 'not-started') return new PreflightError('REMOTE_NOT_SENT',
    'The local write command did not start; preserve work and recheck its prerequisites after correcting the environment; no automatic replay', detail);
  return new PreflightError('REMOTE_RESULT_UNKNOWN', message, detail);
}
export function cannotReconcile(error: unknown, signal?: AbortSignal, afterWrite = false): void {
  if (signal?.aborted && error === signal.reason) throw error;
  if (error instanceof RemoteCleanupFailure || error instanceof RemoteLifecycleFailure) throw error;
  if (afterWrite && error instanceof PreflightError && error.code === 'COMMAND_ORPHANED') throw new RemoteLifecycleFailure(error);
  if (error instanceof PreflightError && ['PROCESS_UNQUIESCED', 'COMMAND_ORPHANED', 'REMOTE_NOT_SENT'].includes(error.code)) throw error;
}
// The process group was stopped, but this read/write cannot establish remote
// truth. Preserve unknown ownership and prohibit any fallback query or replay.
export class RemoteLifecycleFailure extends PreflightError {
  constructor(error: PreflightError) {
    super('REMOTE_RESULT_UNKNOWN', 'COMMAND_ORPHANED interrupted remote reconciliation; preserve ownership and stop without another query or write', error.detail);
  }
}
export class RemoteCleanupFailure extends PreflightError {
  constructor(error?: unknown) {
    super('REMOTE_RESULT_UNKNOWN', 'Local request cleanup failed; retain remote effects and inspect the private request before continuing',
      error instanceof PreflightError ? error.detail : undefined);
  }
}
