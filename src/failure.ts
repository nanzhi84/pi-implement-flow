export type FailureOperation = 'model-setup' | 'implementation-model' | 'review-model'
  | 'git-read' | 'git-write' | 'github-read' | 'github-write'
  | 'prepare' | 'check' | 'accept' | 'cleanup' | 'publish' | 'command';
export type FailureKind = 'infrastructure' | 'configuration' | 'unknown' | 'cancelled' | 'unquiesced';
export type FailureReason = 'eof' | 'dns' | 'tls' | 'timeout' | 'connection-refused' | 'connection-reset'
  | 'service-unavailable' | 'rate-limit' | 'authentication' | 'permission' | 'quota-exhausted'
  | 'missing-dependency' | 'missing-configuration' | 'unsupported-platform' | 'invalid-response'
  | 'output-limit' | 'process-exited' | 'process-terminated' | 'cancelled' | 'process-unquiesced' | 'unclassified';
export interface FailureDetail {
  operation: FailureOperation;
  kind: FailureKind;
  reason: FailureReason;
  // Diagnostic only. Never authorizes retries, repair, or releasing ownership.
  transient?: boolean;
  httpStatus?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  // Local CLI launch fact; not a claim that a remote request was sent or applied.
  commandStart?: 'not-started' | 'started' | 'unknown';
}

// Input is inspected only in memory. No original error/message/cause is retained.
export function classifyFailure(operation: FailureOperation, input?: unknown): FailureDetail {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const text = (typeof input === 'string' ? input : typeof value.message === 'string' ? value.message : '').slice(0, 16_384);
  const code = typeof value.code === 'string' ? value.code : '';
  const status = [value.status, value.statusCode].find(item => Number.isInteger(item) && Number(item) >= 100 && Number(item) <= 599)
    ?? Number(/(?:^|\bHTTP\s+)([45]\d\d)(?:\b|:)/i.exec(text)?.[1]);
  const base = { operation, ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? { httpStatus: Number(status) } : {}) };
  const known = (kind: FailureKind, reason: FailureReason, transient: boolean): FailureDetail => ({ ...base, kind, reason, transient });
  if (/insufficient_quota|quota.?exceeded|out of budget|billing|usage.?limit.?exceeded|monthly usage limit|available balance/i.test(text)) return known('configuration', 'quota-exhausted', false);
  if (status === 401 || /invalid[_ -]?api[_ -]?key|bad credentials|authentication (?:failed|required)|unauthorized/i.test(text)) return known('configuration', 'authentication', false);
  if (code === 'EACCES' || code === 'EPERM' || /permission denied|resource not accessible|access denied/i.test(text)) return known('configuration', 'permission', false);
  if (code === 'ENOENT') return known('configuration', 'missing-dependency', false);
  if (/rate.?limit|too many requests/i.test(text) || status === 429) return known('infrastructure', 'rate-limit', true);
  if ([500, 502, 503, 504, 520, 524].includes(Number(status)) || /overloaded|service.?unavailable|server.?error/i.test(text)) return known('infrastructure', 'service-unavailable', true);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|could not resolve host|no such host/i.test(text)) return known('infrastructure', 'dns', true);
  if (/certificate|TLS handshake|SSL connect|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY/i.test(`${code} ${text}`)) return known('infrastructure', 'tls', true);
  if (code === 'ECONNREFUSED' || /connection refused|ECONNREFUSED/i.test(text)) return known('infrastructure', 'connection-refused', true);
  if (code === 'ECONNRESET' || /connection reset|ECONNRESET|socket hang up/i.test(text)) return known('infrastructure', 'connection-reset', true);
  if (/\bEOF\b|empty reply|stream ended before|stream ended without/i.test(text)) return known('infrastructure', 'eof', true);
  if (code === 'ETIMEDOUT' || /connect timeout|connection timed out|ETIMEDOUT/i.test(text)) return known('infrastructure', 'timeout', true);
  return { ...base, kind: 'unknown', reason: 'unclassified' };
}

export function lifecycleFailure(operation: FailureOperation, code: string): FailureDetail {
  if (code === 'PROCESS_UNQUIESCED' || code === 'COMMAND_ORPHANED') return { operation, kind: 'unquiesced', reason: 'process-unquiesced' };
  if (code === 'COMMAND_CANCELLED') return { operation, kind: 'cancelled', reason: 'cancelled' };
  if (code === 'COMMAND_TIMEOUT') return { operation, kind: 'unknown', reason: 'timeout' };
  if (code === 'COMMAND_OUTPUT_LIMIT') return { operation, kind: 'unknown', reason: 'output-limit' };
  return { operation, kind: 'unknown', reason: 'process-terminated' };
}
