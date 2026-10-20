import { sqlite } from '../db/index.js';
import { ensureBillingReservations, reserveUserCharge } from './billingReservation.js';

/** Wallet debit, reservation and content linkage either all commit or all roll back. */
export function reserveLegacyVideo(userId: number, amount: number, save: (charge: ReturnType<typeof reserveUserCharge>) => number, context: Record<string, unknown> = {}) {
  ensureBillingReservations();
  return sqlite.transaction(() => {
    const charge = reserveUserCharge(userId, amount, 'generate_video', context);
    const contentId = save(charge);
    sqlite.prepare("UPDATE billing_reservations SET context=json_set(context,'$.contentId',?) WHERE id=?").run(contentId, charge.id);
    return { contentId, charge };
  })();
}

export { finalizeReservedContent as finalizeLegacyVideo } from './contentBillingService.js';
import { finalizeReservedContent as finalizeLegacyVideo } from './contentBillingService.js';

/** Persist before POST. After a crash with no task ID, never submit this content again. */
export function markLegacyVideoSubmitting(contentId: number | null): boolean {
  if (contentId === null) return true;
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
    const metadata = JSON.parse(row?.metadata || '{}');
    if (!metadata.billingReservationId || metadata.managedSpecification) return true;
    if (metadata.billingSubmissionStarted) {
      finalizeLegacyVideo(contentId, 'review', { error: '上游提交已开始，请先核实原任务，禁止重复提交' });
      return false;
    }
    metadata.billingSubmissionStarted = new Date().toISOString();
    sqlite.prepare('UPDATE contents SET metadata=? WHERE id=?').run(JSON.stringify(metadata), contentId);
    return true;
  })();
}

export function failLegacyVideo(contentId: number, message: string, confirmedFailure = false): boolean {
  return sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(contentId) as any;
    const metadata = JSON.parse(row?.metadata || '{}');
    return finalizeLegacyVideo(contentId, !confirmedFailure && metadata.billingSubmissionStarted ? 'review' : 'failed', { error: message, failureReason: message, progressText: message });
  })();
}
