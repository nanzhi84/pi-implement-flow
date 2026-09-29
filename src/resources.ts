import { PreflightError } from './contract.ts';
import { PermitPool } from './slots.ts';

export class ProjectResources {
  private readonly exclusive = new PermitPool(1);
  constructor(private readonly mode: 'isolated' | 'exclusive', private readonly stop: (error: unknown, retainOwnership?: boolean) => void,
    private readonly notify: (message: string) => void) {}
  async run<T>(ticket: number, phase: string, signal: AbortSignal,
    action: (cleaned: () => void) => Promise<T>): Promise<T> {
    const permit = this.mode === 'exclusive' ? await this.exclusive.acquire(signal) : undefined;
    let clean = false;
    let unsafe = false;
    let started = false;
    try {
      signal.throwIfAborted();
      started = true;
      this.notify(`FLOW_RESOURCE: ${JSON.stringify({ ticket, phase, event: 'acquired', mode: this.mode })}`);
      const value = await action(() => { clean = true; });
      if (!clean) throw new PreflightError('CLEANUP_PENDING', 'Resource cleanup was not confirmed; preserve its ownership');
      return value;
    } catch (error) {
      unsafe = started && (!clean || (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED')); 
      if (unsafe) { permit?.retain(); this.stop(error, true); }
      else if (error instanceof PreflightError && ['REMOTE_RESULT_UNKNOWN', 'PUBLISH_UNRESOLVED'].includes(error.code)) this.stop(error);
      throw error;
    } finally {
      if (started) this.notify(`FLOW_RESOURCE: ${JSON.stringify({ ticket, phase, event: unsafe ? 'retained' : 'released', mode: this.mode })}`);
      if (!unsafe) permit?.release();
    }
  }
}
