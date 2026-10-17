/** Inspect only protocol wrappers, never prompts or arbitrary response properties.
 * Some gateways put a task JSON in error.message, or truncate that JSON. */
export function pidoiTaskEvidence(payload: unknown): { taskId: string; pollPath?: string; node: any } | undefined {
  const queue: { value: any; depth: number }[] = [{ value: payload, depth: 0 }];
  for (let visited = 0; queue.length && visited < 24; visited++) {
    const { value, depth } = queue.shift()!;
    if (depth > 5 || value == null) continue;
    if (typeof value === 'string') {
      if (value.length > 65536) continue;
      const start = value.indexOf('{'), end = value.lastIndexOf('}');
      try { queue.push({ value: JSON.parse(start >= 0 && end > start ? value.slice(start, end + 1) : value), depth: depth + 1 }); }
      catch {
        // A complete quoted ID can survive an otherwise truncated diagnostic.
        const id = value.match(/"(?:task_id|taskId|id)"\s*:\s*"(task_[A-Za-z0-9_-]{1,160})"/);
        if (id) return { taskId: id[1], node: {} };
      }
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) continue;
    const id = value.task_id || value.taskId || (typeof value.id === 'string' && value.id.startsWith('task_') ? value.id : '');
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      // Only a relative, allowlisted status path for THIS ID. Never forward a key to a response-provided host.
      const candidate = value.task_url;
      let pollPath: string | undefined;
      if (typeof candidate === 'string' && /^\/v1\/(?:image\/generations|images\/generations|videos)\/[A-Za-z0-9_-]+$/.test(candidate)
        && candidate.split('/').at(-1) === id) pollPath = candidate;
      return { taskId: id, pollPath, node: value };
    }
    for (const key of ['data', 'error', 'result', 'message']) if (value[key] != null) queue.push({ value: value[key], depth: depth + 1 });
  }
}

/** Repair accepted submissions missing from the old worker queue. Never creates an upstream task. */
export function restorePidoiJobs(m: Record<string, any>) {
  const jobs = Array.isArray(m.pidoiImageJobs) ? [...m.pidoiImageJobs] : [];
  const count = Number(m.count);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10) return jobs;
  const add = (index: number, evidence: ReturnType<typeof pidoiTaskEvidence>) => {
    if (!evidence || !Number.isInteger(index) || index < 0 || index >= count || jobs.some(j => j.index === index || j.taskId === evidence.taskId)) return;
    jobs.push({ index, taskId: evidence.taskId, pollPath: evidence.pollPath, status: 'processing', protocol: 'async', recoveredFromEvidence: true });
  };
  for (const [index, response] of (Array.isArray(m.upstreamResponses) ? m.upstreamResponses : []).entries()) {
    if (typeof response?.id === 'string' && response.id.startsWith('task_')) add(index, pidoiTaskEvidence({ task_id: response.id, task_url: response.pollPath }));
  }
  const failure = m.submissionFailure;
  if (failure) add(Number.isInteger(failure.index) ? failure.index : count === 1 ? 0 : -1,
    pidoiTaskEvidence({ task_id: failure.taskId, task_url: failure.pollPath }) || pidoiTaskEvidence(failure.message));
  if (count === 1 && !jobs.length) {
    const id = m.upstreamTaskId || m.taskId || (m.upstreamTaskIds?.length === 1 ? m.upstreamTaskIds[0] : '');
    if (typeof id === 'string' && id.startsWith('task_')) add(0, pidoiTaskEvidence({ task_id: id }));
    else add(0, pidoiTaskEvidence(m.failureReason));
  }
  return jobs.sort((a, b) => a.index - b.index);
}
