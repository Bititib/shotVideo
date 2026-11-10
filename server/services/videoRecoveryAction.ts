// The application runs queue/recovery workers in this process. Prevent an admin
// refund or a second mutation while a read-only candidate verification awaits I/O.
const verifying = new Set<number>();
export function assertNoTaskIdVerification(contentId: number): void {
  if (verifying.has(contentId)) throw {status:409,message:'正在核验补录编号，请等待查询结束后再操作'};
}
export function beginTaskIdVerification(contentId: number): () => void {
  assertNoTaskIdVerification(contentId);
  verifying.add(contentId);
  return () => { verifying.delete(contentId); };
}

// Shared with the specification executor so administrative settlement cannot race I/O.
export const activeSpecificationTasks = new Set<number>();
