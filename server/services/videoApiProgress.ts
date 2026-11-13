/** Public display projection only: never decides submission, retry or settlement. */
export function normalizeVideoApiStatus(localStatus: unknown, upstreamStatus: unknown, progress: number): 'queued' | 'processing' | 'completed' | 'failed' {
  const local = String(localStatus || '').trim().toLowerCase();
  const upstream = String(upstreamStatus || '').trim().toLowerCase();
  if (['completed', 'success', 'succeeded'].includes(local)) return 'completed';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(local)) return 'failed';
  if (local === 'queued' || ['queued', 'pending'].includes(upstream)) return 'queued';
  // A missing percentage (or a submission receipt) is not evidence of a queue.
  return 'processing';
}

export function videoApiProgress(localStatus: unknown, metadata: Record<string, any>) {
  const raw = metadata.progress;
  const valid = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100;
  const known = valid && (metadata.progressKnown === true || (metadata.progressKnown !== false && raw > 0));
  const status = normalizeVideoApiStatus(localStatus, metadata.upstreamStatus, valid ? raw : 0);
  const upstream = String(metadata.upstreamStatus || '').trim().toLowerCase();
  const phase = status === 'completed' || status === 'failed' ? status
    : metadata.requiresReview || metadata.hayaNeedsReview ? 'review'
    : String(localStatus).toLowerCase() === 'queued' ? 'website_queue'
    : ['queued', 'pending'].includes(upstream) ? 'upstream_queue'
    : ['completed', 'success', 'succeeded'].includes(upstream) ? 'saving'
    : ['processing', 'in_progress', 'running'].includes(upstream) || known && raw > 0 ? 'generating'
    : metadata.videoId || metadata.upstreamTaskId || upstream === 'submitted' || metadata.videoSubmissionState === 'accepted' ? 'accepted'
    : metadata.submissionStartedAt || metadata.videoSubmissionState === 'preparing' ? 'submitting'
    : 'waiting';
  const progressKnown = phase === 'completed' || phase === 'generating' && known;
  // Keep numeric fields for existing clients; new clients must use progress_known.
  const progress = phase === 'completed' ? 100 : progressKnown ? raw : 0;
  return { status, phase, queue_scope: phase === 'website_queue' ? 'website' : phase === 'upstream_queue' ? 'upstream' : null,
    progress, progress_pct: progress, progress_known: progressKnown };
}
