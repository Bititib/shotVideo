type Task = { id: string; dbId?: number; status: string };

export function videoTaskDatabaseId(task: Task): number | null {
  const id = task.dbId ?? (task.id.startsWith('db_') ? Number(task.id.slice(3)) : NaN);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function shouldPollVideoTask(task: Task): boolean {
  return (task.status === 'generating' || task.status === 'review') && videoTaskDatabaseId(task) !== null;
}

/** Review retains the original order without displaying a generating animation. */
export function videoTaskNeedsReview(record: { status?: string; metadata?: any }): boolean {
  if (['completed','success','failed','error'].includes(record.status || '')) return false;
  if (record.status === 'review') return true;
  try {
    const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata;
    return Boolean(meta?.requiresReview || meta?.hayaNeedsReview);
  } catch { return false; }
}
