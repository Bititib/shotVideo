import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
vi.mock('../server/db/index.js',async()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db,sqlite } from '../server/db/index.js';
import { users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { createMusicTask, ensureMusicJobs, getMusicTask, listMusicTasks, musicFile, resumeMusicTasks } from '../server/services/musicGenerationService.js';
import { reserveUserCharge } from '../server/services/billingReservation.js';

const owner={userId:1};
const upstream='a'.repeat(32);
const files=new Set<string>();
let channelId:number;
const balance=()=>(sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
beforeAll(()=>ensureMusicJobs());
beforeEach(()=>{
  sqlite.exec('SAVEPOINT legacy_music');
  db.insert(users).values({id:1,email:'legacy@test.invalid',username:'legacy',passwordHash:'test',balance:20}).run();
  channelId=ChannelService.createChannel({name:'miniKey',type:'minikey',baseUrl:'https://minikey.work',apiKey:'mk_secret'});
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Unexpected request');}));
});
afterEach(async()=>{
  for(const file of files)await fs.rm(file,{force:true});
  files.clear();vi.unstubAllGlobals();sqlite.exec('ROLLBACK TO legacy_music; RELEASE legacy_music');
});
function legacy(state:string,upstreamId?:string) {
  const id=randomUUID(),isDone=state==='completed';
  const reservation=isDone?undefined:reserveUserCharge(1,2,'generate_music');
  const content=sqlite.prepare("INSERT INTO contents(user_id,type,title,input_text,model_id,cost,status,result_url,metadata) VALUES(1,'music','旧音乐','民谣','old-model',2,?,?,?)")
    .run(isDone?'completed':'processing',isDone?'/uploads/music/'+id+'.mp3':null,
      JSON.stringify({billingReservationId:reservation?.id,billingStatus:isDone?'settled':'reserved'}));
  const digest=createHash('sha256').update(JSON.stringify(['https://minikey.work','mk_secret'])).digest('hex');
  sqlite.prepare(`INSERT INTO music_jobs(id,owner,request_key,request_hash,content_id,channel_id,credential_hash,payload,state,upstream_id)
    VALUES(?,'user:1',?,'legacy-hash',?,?,?,?,?,?)`).run(id,randomUUID(),Number(content.lastInsertRowid),channelId,digest,'{"model":"suno-v6"}',state,upstreamId||null);
  return id;
}
it('retains old completed orders and original single-file downloads without using the upstream at all',async()=>{
  const id=legacy('completed',upstream);
  const file=path.resolve('data/uploads/music',id+'.mp3');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'ID3 legacy');files.add(file);
  expect(listMusicTasks(owner).find(row=>row.id===id)).toMatchObject({status:'completed',operation:null});
  expect(await fs.readFile(musicFile(id,owner),'utf8')).toBe('ID3 legacy');
  expect(()=>musicFile(id,{userId:2})).toThrow('不存在');
  expect(()=>createMusicTask({model:'old-model',prompt:'新的',client_request_id:randomUUID()},owner)).toThrow('未启用');
  await resumeMusicTasks();expect(fetch).not.toHaveBeenCalled();
});
it('refunds unsent legacy orders, keeps interrupted orders for review and only queries an accepted original',async()=>{
  const queued=legacy('queued'),started=legacy('submitting'),accepted=legacy('accepted',upstream);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({id:upstream,status:'failed',error:'legacy fail'}));
  await resumeMusicTasks();
  expect(getMusicTask(queued,owner).status).toBe('failed');
  expect(getMusicTask(started,owner).status).toBe('review');
  expect(getMusicTask(accepted,owner).status).toBe('failed');
  expect(balance()).toBe(18);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][1]?.method).not.toBe('POST');
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(upstream);
});
