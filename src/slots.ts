import { PreflightError } from './contract.ts';

interface Permit { release(): void; retain(): void; }
interface Waiter { signal?: AbortSignal; resolve(value: Permit): void; reject(error: unknown): void; abort(): void; }

// An in-memory FIFO only; no execution or attempt records survive the run.
export class PermitPool {
  private active = 0;
  private retained = 0;
  private waiting: Waiter[] = [];
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid activity capacity');
  }
  acquire(signal?: AbortSignal): Promise<Permit> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        this.waiting = this.waiting.filter(item => item !== waiter);
        reject(signal?.reason ?? new Error('Cancelled'));
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }
  private drain(): void {
    if (this.retained === this.capacity) {
      for (const waiter of this.waiting.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.reject(new PreflightError('CLEANUP_PENDING', 'All activity capacity is retained by unquiesced work; preserve resources and report stopping'));
      }
      return;
    }
    while (this.active < this.capacity && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue; }
      this.active += 1;
      let state: 'owned' | 'released' | 'retained' = 'owned';
      waiter.resolve({
        release: () => { if (state !== 'owned') return; state = 'released'; this.active -= 1; this.drain(); },
        retain: () => { if (state !== 'owned') return; state = 'retained'; this.retained += 1; this.drain(); },
      });
    }
  }
}

export interface ActivityLabel { ticket: number; phase: string; kind: string; codeSha: string; }
export class ActivitySlots {
  private readonly pool: PermitPool;
  constructor(capacity: number, private readonly stop: (error: unknown) => void,
    private readonly notify: (message: string) => void) { this.pool = new PermitPool(capacity); }
  run<T>(label: ActivityLabel, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    return this.execute(label, action, signal);
  }
  runCleanup<T>(label: ActivityLabel, action: () => Promise<T>): Promise<T> { return this.execute(label, action); }
  private async execute<T>(label: ActivityLabel, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const permit = await this.pool.acquire(signal);
    let unsafe = false;
    let started = false;
    try {
      signal?.throwIfAborted();
      started = true;
      this.notify(`FLOW_ACTIVITY: ${JSON.stringify({ ...label, event: 'start' })}`);
      return await action();
    } catch (error) {
      if (error instanceof PreflightError && error.code === 'PROCESS_UNQUIESCED') {
        unsafe = true;
        // Never wake another callback before unsafe ownership is retained.
        permit.retain(); this.stop(error);
      }
      throw error;
    } finally {
      if (started) this.notify(`FLOW_ACTIVITY: ${JSON.stringify({ ...label, event: unsafe ? 'retained' : 'end' })}`);
      if (!unsafe) permit.release();
    }
  }
}

export class SerialControl {
  private readonly pool = new PermitPool(1);
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const permit = await this.pool.acquire(signal);
    try { signal.throwIfAborted(); return await action(); }
    finally { permit.release(); }
  }
}
