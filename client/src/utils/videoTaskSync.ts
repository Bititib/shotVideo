type Task = { id: string; dbId?: number; status: string };

export function videoTaskDatabaseId(task: Task): number | null {
  const id = task.dbId ?? (task.id.startsWith('db_') ? Number(task.id.slice(3)) : NaN);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function shouldPollVideoTask(task: Task): boolean {
  return task.status === 'generating' && videoTaskDatabaseId(task) !== null;
}
