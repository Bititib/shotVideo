import { isSnumomWanChannel } from './snumomWanAdapter.js';

/** Only a complete routing rejection proves that no generation was submitted. */
export function isSnumomNoChannelRejection(status: number, text: string,
  channel?: { type?: string | null; baseUrl?: string | null }, headers?: Pick<Headers, 'get'>): boolean {
  if (!isSnumomWanChannel(channel) || ![200, 400, 404, 500, 503].includes(status)) return false;
  let body: any;
  try { body = JSON.parse(text); } catch { return false; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const message = typeof body.error === 'string' ? body.error : body.error?.message;
  // Never inspect prompts, echoed input, HTML or arbitrary nested messages.
  if (typeof message !== 'string'
    || !/^No available channel for model \S+ under group \S+(?: \(distributor\))?(?: \(request id: [\w-]+\))?\s*$/i.test(message)) return false;
  const hasEvidence = (value: any): boolean => {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, item]) => {
      if (/^(?:id|task_id|taskId|videoId|upstreamTaskId|url|video_url|result_url)$/i.test(key) && item) return true;
      if (/^(?:status|state)$/i.test(key) && /^(?:queued|pending|processing|in_progress|completed|succeeded|success)$/i.test(String(item))) return true;
      return hasEvidence(item);
    });
  };
  // request_id in this routing error is a diagnostic trace, not a polling ID.
  if (hasEvidence(body) || ['x-task-id', 'task-id', 'location'].some(key => headers?.get(key))) return false;
  return true;
}
