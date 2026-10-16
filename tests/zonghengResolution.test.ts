import { beforeEach, describe, expect, it } from 'vitest';
import { db, sqlite } from '../server/db/index';
import { users, organizations, apiTokens, channels, contents } from '../server/db/schema';
import { confirmZonghengNotAccepted, refundConfirmedZonghengVideo } from '../server/services/zonghengSubmissionResolutionService';
import { reserveUserCharge } from '../server/services/billingReservation';
import { videoTaskPhase } from '../shared/videoTaskPhase';
import { sanitizeContentRoutingForClient } from '../server/services/contentService';
import { publicGenerationStatus, publicGenerationError } from '../shared/generationMessages';
const note='已按业务订单号核对，上游确认未创建任务且不会继续受理';
const row=()=>sqlite.prepare('SELECT * FROM contents WHERE id=12965').get() as any;
const balance=()=> (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
function add(meta:Record<string,any>={},patch:Record<string,any>={}) {
  db.insert(contents).values({id:12965,userId:1,type:'video',modelId:'ZH-kksedanco2.5',status:'review',cost:6.5,
    metadata:JSON.stringify({channelId:21,billingSource:'user',billingBalanceSource:'user',zonghengSubmissionStarted:'today',...meta}),...patch}).run();
}
beforeEach(()=>{
  for(const table of ['contents','users','organizations','api_tokens','channels'])sqlite.exec('DELETE FROM '+table);
  sqlite.exec('DROP TABLE IF EXISTS billing_reservations; DROP TABLE IF EXISTS billing_resolution_audit; DROP TRIGGER IF EXISTS reject_failure;');
  db.insert(users).values({id:1,email:'test',username:'test',passwordHash:'test',balance:93.5}).run();
  db.insert(channels).values({id:21,name:'private channel',type:'zongheng',baseUrl:'https://channel.invalid',apiKey:'secret'}).run();
});
describe('confirmed Zongheng non-acceptance refunds',()=>{
  it('refunds a historical reviewed order once, clears review and records the confirmation',()=>{
    add();expect(confirmZonghengNotAccepted(12965,9,true,note)).toMatchObject({refundedAmount:6.5,alreadyResolved:false});
    expect(row()).toMatchObject({status:'failed',cost:0});expect(balance()).toBe(100);
    expect(JSON.parse(row().metadata)).toMatchObject({requiresReview:false,billingStatus:'refunded',zonghengNotAcceptedResolution:{adminId:9,note}});
    expect(confirmZonghengNotAccepted(12965,10,true,note).alreadyResolved).toBe(true);expect(balance()).toBe(100);
  });
  it.each([{videoId:'vid_accepted'},{taskId:'vid_accepted'},{upstreamTaskIds:['vid_accepted']},{upstreamResultUrl:'https://media.invalid/result.mp4'},{batchItemId:1},{managedSpecification:true}])('refuses to refund an unverified or separately owned task: %j',meta=>{
    add(meta);expect(()=>confirmZonghengNotAccepted(12965,9,true,note)).toThrow();expect(balance()).toBe(93.5);expect(row().status).toBe('review');
  });
  it('requires explicit confirmation, a useful note, and a reviewed record',()=>{
    add();expect(()=>confirmZonghengNotAccepted(12965,9,false,note)).toThrow();expect(()=>confirmZonghengNotAccepted(12965,9,true,'短')).toThrow();
    sqlite.exec("UPDATE contents SET status='processing' WHERE id=12965");expect(()=>confirmZonghengNotAccepted(12965,9,true,note)).toThrow('仅可');expect(balance()).toBe(93.5);
  });
  it('returns money to the original organization after membership changed',()=>{
    db.insert(organizations).values([{id:1,name:'original',balance:13.5},{id:2,name:'current',balance:30}]).run();
    sqlite.exec('UPDATE users SET org_id=2 WHERE id=1');add({billingBalanceSource:'org',billingOrgId:1});confirmZonghengNotAccepted(12965,9,true,note);
    expect(sqlite.prepare('SELECT balance FROM organizations WHERE id=1').get()).toEqual({balance:20});expect(balance()).toBe(93.5);
  });
  it.each([false,true])('refunds the original token accounting once, linked=%s',linked=>{
    db.insert(apiTokens).values({id:1,userId:1,name:'test',tokenKey:'test',balance:linked?-1:93.5,usedAmount:6.5}).run();
    add({billingSource:linked?'user':'token',tokenId:1});confirmZonghengNotAccepted(12965,9,true,note);confirmZonghengNotAccepted(12965,9,true,note);
    expect(sqlite.prepare('SELECT balance,used_amount FROM api_tokens WHERE id=1').get()).toEqual({balance:linked?-1:100,used_amount:0});expect(balance()).toBe(linked?100:93.5);
  });
  it('reconciles a reservation and the historical content in the same transaction',()=>{
    sqlite.exec('UPDATE users SET balance=100 WHERE id=1');const reservation=reserveUserCharge(1,6.5,'generate_video');reservation.review();
    add({billingReservationId:reservation.id,billingStatus:'review'});confirmZonghengNotAccepted(12965,9,true,note);
    expect(balance()).toBe(100);expect(sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(reservation.id)).toEqual({state:'refunded'});
    expect(sqlite.prepare('SELECT admin_id,refunded FROM billing_resolution_audit WHERE reservation_id=?').get(reservation.id)).toEqual({admin_id:9,refunded:6.5});
  });
  it.each(['manual','automatic'])('rolls back all balance changes if content finalization fails: %s',kind=>{
    add();sqlite.exec("CREATE TRIGGER reject_failure BEFORE UPDATE OF status ON contents WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    expect(()=>kind==='manual'?confirmZonghengNotAccepted(12965,9,true,note):refundConfirmedZonghengVideo(12965,'explicit failure')).toThrow('simulated storage failure');
    expect(balance()).toBe(93.5);expect(row()).toMatchObject({status:'review',cost:6.5});
  });
  it('finalizes confirmed upstream failure only once even when retried',()=>{
    add({videoId:'vid_failure'},{status:'processing'});refundConfirmedZonghengVideo(12965,'上游明确返回失败');refundConfirmedZonghengVideo(12965,'重复轮询失败');
    expect(balance()).toBe(100);expect(row()).toMatchObject({status:'failed',cost:0});
  });
  it('automatically refunds a reserved legacy charge without leaving a live reservation',()=>{
    sqlite.exec('UPDATE users SET balance=100 WHERE id=1');const reservation=reserveUserCharge(1,6.5,'generate_video');
    add({billingReservationId:reservation.id,billingStatus:'reserved'},{status:'processing'});
    refundConfirmedZonghengVideo(12965,'连接生成服务失败，请求未发送');refundConfirmedZonghengVideo(12965,'重复处理');
    expect(balance()).toBe(100);expect(sqlite.prepare('SELECT state,actual FROM billing_reservations WHERE id=?').get(reservation.id)).toEqual({state:'refunded',actual:0});
  });
  it('does not expose reconciliation notes to ordinary users',()=>{
    const metadata={upstreamGenerated:true,upstreamDeliveryPending:true,progressText:'视频已生成，正在等待结果交付',zonghengNotAcceptedResolution:{adminId:9,note:'private channel account and order'}};
    const sanitized=sanitizeContentRoutingForClient({status:'processing',metadata});
    expect(sanitized.metadata).not.toHaveProperty('zonghengNotAcceptedResolution');expect(sanitized.metadata).toMatchObject({upstreamGenerated:true,upstreamDeliveryPending:true,progressText:'视频已生成，正在等待结果交付'});
  });
  it('does not redirect an organization refund when the original account is missing',()=>{
    add({billingBalanceSource:'org',billingOrgId:99});expect(()=>confirmZonghengNotAccepted(12965,9,true,note)).toThrow('组织不存在');expect(balance()).toBe(93.5);
  });
});
describe('public video phases',()=>{
  it('distinguishes generated-but-undelivered videos, local saving, final results, and review',()=>{
    const meta={upstreamGenerated:true,upstreamDeliveryPending:true};
    expect(videoTaskPhase('processing',meta)).toBe('awaiting_delivery');
    expect(videoTaskPhase('processing',{...meta,progressText:'视频已生成，正在保存到本站存储'})).toBe('saving');
    expect(videoTaskPhase('completed',meta)).toBe('completed');expect(videoTaskPhase('failed',meta)).toBe('failed');expect(videoTaskPhase('review',meta)).toBe('review');
    expect(videoTaskPhase('processing','{bad')).toBe('processing');
    expect(publicGenerationStatus('视频已生成，正在等待结果交付')).toBe('视频已生成，正在等待结果交付');
    expect(publicGenerationError('连接生成服务失败，请求未发送')).toBe('任务未提交成功，请稍后重试。');
  });
});
