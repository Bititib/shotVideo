import { beforeEach, afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ImageAnalysisJobStore, type ImageJobInput } from '../server/services/imageAnalysisJobStore';
let db: Database.Database, store: ImageAnalysisJobStore;
const input: ImageJobInput = { id: 'test-image-job-12345', owner: 7, modelId: 1, requiresText: false, quota: 3,
  files: [{path:'first.jpg',mime:'image/jpeg',hash:'one'}, {path:'second.jpg',mime:'image/jpeg',hash:'two'}] };
const result = {overallConcept:'画面',aspectRatio:'1:1',reversePrompt:'prompt',reversePromptTranslation:'提示词',keywords:[],styleTags:[]};
beforeEach(() => {
  db = new Database(':memory:');
  db.exec("CREATE TABLE usage_logs (id INTEGER PRIMARY KEY,user_id INTEGER,analysis_type TEXT,model_id INTEGER,status TEXT,created_at TEXT DEFAULT (datetime('now')))");
  store = new ImageAnalysisJobStore(db);
});
afterEach(() => db.close());
it('reserves quota for every image atomically and rejects excess without creating partial jobs', () => {
  store.create(input);
  expect(() => store.create({...input,id:'another-job-12345'})).toThrow('剩余 1 次');
  expect(store.get(7,'another-job-12345')).toBeNull();
  expect((db.prepare('SELECT count(*) AS n FROM usage_logs').get() as any).n).toBe(2);
});
it('deduplicates repeated requests and rejects reuse with different images', () => {
  expect(store.create(input)).toBe(true); expect(store.create(input)).toBe(false);
  expect(() => store.create({...input,requiresText:true})).toThrow('另一组图片');
  expect(store.get(8,input.id)).toBeNull();
});
it('keeps successes and completes each usage once while another image fails', () => {
  store.create(input); const first=store.claim(); store.finish(first,result,null);
  const second=store.claim(); store.finish(second,null,'Gemini INVALID_ARGUMENT: invalid image');
  store.finish(second,null,'duplicate error'); store.finish(first,result,null);
  expect(store.get(7,input.id)?.items.map(item=>item.status)).toEqual(['completed','error']);
  expect(store.get(7,input.id)?.items[0].result).toEqual(result);
  expect((db.prepare('SELECT count(*) AS n FROM usage_logs').get() as any).n).toBe(1);
  expect(store.claim()).toBeNull();
});
it('recovers only unsubmitted images and never reclaims an interrupted submission', () => {
  store.create(input); const first=store.claim(); store.recover();
  expect(store.get(7,input.id)?.items[0].status).toBe('interrupted');
  const next=store.claim(); expect(next.position).toBe(1); store.finish(next,result,null);
  expect(store.claim()).toBeNull();
  // A late response from a previous executor cannot overwrite the recovery decision.
  store.finish(first,null,'late error'); expect(store.get(7,input.id)?.items[0].status).toBe('interrupted');
});
it('retains a successful result if content-library saving throws', () => {
  store.create(input); const item=store.claim();
  expect(()=>store.finish(item,result,null,()=>{throw new Error('disk full');})).toThrow('disk full');
  store.finish(item,result,'内容库保存未完成');
  expect(store.get(7,input.id)?.items[0].result).toEqual(result);
  expect((db.prepare("SELECT count(*) AS n FROM usage_logs WHERE status='success'").get() as any).n).toBe(1);
});
