import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { isIP } from 'node:net';

/** Observation only. Missing events are not evidence that a request was unsent. */
export interface SubmissionTransportEvidence {
  startedAt: string;
  timeoutMs: number;
  requestBytes: number;
  requestObserved: boolean;
  requestCreatedMs?: number;
  socketWriteStartedMs?: number;
  requestBodySentMs?: number;
  responseHeadersMs?: number;
  responseBodyCompleteMs?: number;
  httpStatus?: number;
  peerIp?: string;
  requestId?: string;
  transportCode?: string;
  elapsedMs: number;
}
type Trace = { started: number; evidence: SubmissionTransportEvidence; closed: boolean };
const context = new AsyncLocalStorage<Trace>();
const requests = new WeakMap<object, Trace>();
const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : undefined;

function listen(name: string, update: (trace: Trace, data: any) => void) {
  channel('undici:' + name).subscribe((data: any) => {
    // Diagnostic callbacks must never interrupt a generation or expose headers/body.
    try {
      const trace = requests.get(data.request);
      if (trace && !trace.closed) update(trace, data);
    } catch { /* observational only */ }
  });
}
channel('undici:request:create').subscribe((data: any) => {
  try {
    const trace = context.getStore();
    if (!trace || trace.closed) return;
    requests.set(data.request, trace);
    trace.evidence.requestObserved = true;
    trace.evidence.requestCreatedMs = Date.now() - trace.started;
  } catch { /* observational only */ }
});
// sendHeaders is BEFORE the first socket write; do not call this delivery/acceptance.
listen('client:sendHeaders', (t, d) => {
  t.evidence.socketWriteStartedMs = Date.now() - t.started;
  if (typeof d.socket?.remoteAddress === 'string' && isIP(d.socket.remoteAddress)) t.evidence.peerIp = d.socket.remoteAddress;
});
listen('request:bodySent', t => { t.evidence.requestBodySentMs = Date.now() - t.started; });
listen('request:headers', (t, d) => {
  t.evidence.responseHeadersMs = Date.now() - t.started;
  t.evidence.httpStatus = d.response.statusCode;
});
listen('request:trailers', t => { t.evidence.responseBodyCompleteMs = Date.now() - t.started; });
listen('request:error', (t, d) => { t.evidence.transportCode = safeCode(d.error?.code); });

export function submissionTransportTrace(timeoutMs: number, requestBytes: number) {
  const started = Date.now();
  const trace: Trace = { started, closed: false, evidence: {
    startedAt: new Date(started).toISOString(), timeoutMs, requestBytes, requestObserved: false, elapsedMs: 0,
  } };
  return {
    run: <T>(action: () => T): T => context.run(trace, action),
    response(response: Response) {
      trace.evidence.httpStatus = response.status;
      trace.evidence.responseHeadersMs ??= Date.now() - started;
      const id = response.headers.get('x-request-id') || response.headers.get('request-id');
      if (id && /^[A-Za-z0-9_.-]{1,160}$/.test(id) && !/^(sk-|sess-)/i.test(id)) trace.evidence.requestId = id;
    },
    bodyComplete() { trace.evidence.responseBodyCompleteMs ??= Date.now() - started; },
    snapshot(): SubmissionTransportEvidence { return { ...trace.evidence, elapsedMs: Date.now() - started }; },
    close() { trace.closed = true; },
  };
}
