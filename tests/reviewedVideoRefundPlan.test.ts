import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { sqlite } from '../server/db/index.js';
import { previewReviewedVideoRefunds, applyReviewedVideoRefunds } from '../server/services/reviewedVideoRefundPlan.js';
import { confirmReviewedVideoFailureAndRefund } from '../server/services/zonghengSubmissionResolutionService.js';
import { persistVideoSubmissionReceipt, findVideoSubmissionReceipt } from '../server/services/videoSubmissionReceiptService.js';

beforeEach(()=>{
  sqlite.exec('DROP TRIGGER IF EXISTS refund_failure; DELETE FROM contents; DELETE FROM users;');
  findVideoSubmissionReceipt(1); sqlite.exec('DELETE FROM video_submission_receipts');
  sqlite.exec("INSERT INTO users(id,email,username,password_hash,role,balance,is_active) VALUES (1,'user','user','test','user',80,1),(9,'admin','admin','test','super_admin',0,1)");
});
function add(id:number,meta:Record<string,unknown>={}) {
  sqlite.prepare("INSERT INTO contents(id,user_id,type,status,cost,metadata) VALUES (?,1,'video','review',7,?)")
    .run(id,JSON.stringify({requiresReview:true,billingStatus:'review',videoSubmissionState:'unknown',billingSource:'user',billingBalanceSource:'user',...meta}));
}
const balance=()=> (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const apply=(plan:ReturnType<typeof previewReviewedVideoRefunds>)=>applyReviewedVideoRefunds(sqlite,plan,9,true,confirmReviewedVideoFailureAndRefund);

it('previews historical submission reviews without changing balances or records',()=>{
  add(1); add(2,{videoId:'real-task'}); add(3,{reviewKind:'query'}); add(4,{batchItemId:2}); add(5,{videoSubmissionState:'submitting'});
  const before=sqlite.prepare('SELECT * FROM contents').all();
  const plan=previewReviewedVideoRefunds(sqlite);
  expect(plan.items.filter(i=>!i.blockedReason).map(i=>i.id)).toEqual([1]);
  expect(balance()).toBe(80); expect(sqlite.prepare('SELECT * FROM contents').all()).toEqual(before);
});
it('uses the existing refund transaction to return original funds and mark failed only once',()=>{
  add(1);add(2,{videoId:'未取得上游任务 ID'});
  const plan=previewReviewedVideoRefunds(sqlite);
  expect(apply(plan)).toMatchObject({refundedCount:2,refundedAmount:14,errorCount:0});
  expect(balance()).toBe(94);
  expect(sqlite.prepare('SELECT status,cost FROM contents WHERE id=1').get()).toEqual({status:'failed',cost:0});
  expect(apply(plan)).toMatchObject({refundedCount:0,refundedAmount:0,skippedCount:2});expect(balance()).toBe(94);
});
it('does not include new orders or refund changed orders after the preview',()=>{
  add(1);const plan=previewReviewedVideoRefunds(sqlite);add(2);
  sqlite.prepare('UPDATE contents SET cost=12 WHERE id=1').run();
  expect(apply(plan)).toMatchObject({refundedCount:0,skippedCount:1});expect(balance()).toBe(80);
});
it('checks an independent receipt again at execution time',()=>{
  add(1);const plan=previewReviewedVideoRefunds(sqlite);
  persistVideoSubmissionReceipt({contentId:1,upstreamTaskId:'real-task',provider:'hmstudio',channelId:13,channelApiKeyId:1});
  expect(apply(plan)).toMatchObject({refundedCount:0,skippedCount:1});expect(balance()).toBe(80);
});
it('rolls back the failed item and continues other orders without losing the error report',()=>{
  add(1);add(2);const plan=previewReviewedVideoRefunds(sqlite);
  sqlite.exec("CREATE TRIGGER refund_failure BEFORE UPDATE OF status ON contents WHEN NEW.id=1 AND NEW.status='failed' BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  expect(apply(plan)).toMatchObject({refundedCount:1,refundedAmount:7,errorCount:1});
  expect(balance()).toBe(87);expect(sqlite.prepare('SELECT status,cost FROM contents WHERE id=1').get()).toEqual({status:'review',cost:7});
});
it('requires an active administrator and explicit confirmation; rejects duplicate manifest rows',()=>{
  add(1);const plan=previewReviewedVideoRefunds(sqlite);
  expect(()=>applyReviewedVideoRefunds(sqlite,plan,9,false,confirmReviewedVideoFailureAndRefund)).toThrow('确认');
  expect(()=>applyReviewedVideoRefunds(sqlite,plan,1,true,confirmReviewedVideoFailureAndRefund)).toThrow('管理员');
  expect(()=>apply({...plan,items:[...plan.items,...plan.items]})).toThrow('清单格式');expect(balance()).toBe(80);
});
