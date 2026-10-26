/** UI copy is never evidence that a provider accepted a generation. */
export function isTaskIdPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && ['未取得上游任务 ID', '未取得上游任务ID', '无已保存 ID（旧记录）', '未保存上游任务 ID'].includes(value.trim());
}
