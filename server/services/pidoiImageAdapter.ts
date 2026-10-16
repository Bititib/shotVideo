export function isPidoiImageChannel(channel: { baseUrl?: string; name?: string }) {
  try { const host = new URL(channel.baseUrl || '').hostname; return host === 'pidoi.com' || host.endsWith('.pidoi.com'); } catch { return false; }
}
type Channel = { baseUrl: string; apiKey: string };
const endpoint = (c: Channel) => c.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/image/generations';
export class PidoiImageError extends Error {
  constructor(message: string, public confirmedFailure = false) { super(message); }
}
export function parsePidoiImageTask(raw: any) {
  if (raw?.code !== 'success' || !raw.data) throw new PidoiImageError(raw?.message || 'Pidoi 图片任务查询失败');
  const data = raw.data;
  const status = data.status === 'SUCCESS' ? 'completed' : data.status === 'FAILURE' ? 'failed' : 'processing';
  if (!['SUCCESS', 'FAILURE', 'IN_PROGRESS'].includes(data.status)) throw new PidoiImageError('Pidoi 返回未知任务状态');
  return { taskId: String(data.task_id || ''), status, progress: Math.max(0, Math.min(100, parseFloat(data.progress) || 0)),
    imageUrl: status === 'completed' ? String(data.result_url || '') : '', error: String(data.fail_reason || ''), raw };
}
async function request(c: Channel, suffix: string, body: unknown, fetchImpl: typeof fetch) {
  try {
  const response = await fetchImpl(endpoint(c) + suffix, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw Object.assign(new PidoiImageError(`Pidoi 图片接口 HTTP ${response.status}`), { status: response.status });
  return parsePidoiImageTask(await response.json());
  } catch (error: any) {
    throw Object.assign(error instanceof Error ? error : new Error('Pidoi 请求失败'), {
      imageRequestStage: body === undefined ? 'poll' : 'submit',
      upstreamTaskId: suffix ? decodeURIComponent(suffix.slice(1)) : undefined,
    });
  }
}
export async function submitPidoiImage(c: Channel, body: Record<string, any>, fetchImpl = fetch) {
  // Never retry a POST: a transport failure does not mean the task was rejected.
  const task = await request(c, '', body, fetchImpl);
  if (!task.taskId) throw new PidoiImageError('Pidoi 未返回任务 ID，提交结果待核对');
  return task;
}
export function pollPidoiImage(c: Channel, taskId: string, fetchImpl = fetch) {
  return request(c, '/' + encodeURIComponent(taskId), undefined, fetchImpl);
}
export async function generatePidoiImage(c: Channel, body: Record<string, any>, onSubmitted: (id: string) => void, fetchImpl = fetch) {
  let task = await submitPidoiImage(c, body, fetchImpl);
  onSubmitted(task.taskId);
  const id = task.taskId;
  const deadline = Date.now() + 20 * 60_000;
  while (true) {
    if (task.status === 'failed') throw new PidoiImageError(task.error || 'Pidoi 图片生成失败', true);
    if (task.status === 'completed' && task.imageUrl) return { ...task, taskId: id, reportedImageUrl: task.imageUrl };
    if (Date.now() >= deadline) throw new PidoiImageError('图片仍在处理中，保留任务等待恢复');
    await new Promise(resolve => setTimeout(resolve, 5000));
    task = await pollPidoiImage(c, id, fetchImpl);
  }
}
