import { afterAll, afterEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { sqlite } from '../server/db/index.js';
import { ComicDramaQueueService } from '../server/services/comicDramaQueueService.js';

afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());

it('dispatches exact storyboard durations from the managed queue and reports rejected durations on the same shot', async () => {
  sqlite.prepare("INSERT INTO users(id,username,email,password_hash) VALUES(1,'test','test@example.test','test')").run();
  const cases = [
    {model:'sd-2.5-fullblood-line2',requested:7,sent:7}, {model:'sd-2.5-fullblood',requested:21,sent:21},
    {model:'sd-2.5-fullblood-line2',requested:31,sent:31}, {model:'legacy-video',requested:7,sent:5},
  ];
  const calls: Array<{model:string;video_length:number}> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/\/api\/video\/generate$/);
    const body = JSON.parse(String(init.body));
    calls.push(body);
    if (body.video_length > 30) return Response.json({error:'时长必须为 5–30 秒'}, {status:400});
    return new Response('data: {"type":"complete","videoUrl":"https://video.example/result.mp4"}\n\n');
  }));
  sqlite.prepare("INSERT INTO comic_drama_projects(id,user_id,script,state) VALUES(1,1,'剧本',?)").run(JSON.stringify({managedScope:'all'}));
  for (const [index, item] of cases.entries()) {
    const id = index + 1;
    sqlite.prepare("INSERT INTO comic_drama_episodes(id,user_id,project_id,episode_number,status,blueprint,state) VALUES(?,1,1,?,'queued','{\"title\":\"剧本\"}',?)")
      .run(id,id,JSON.stringify({videoModel:item.model,qualityEnabled:false}));
    sqlite.prepare("INSERT INTO comic_drama_tasks(id,project_id,user_id,episode_id,kind,entity_key,payload) VALUES(?,1,1,?,'video','shot',?)")
      .run(id,id,JSON.stringify({shot:{shotNumber:1,duration:item.requested,videoPrompt:'跑步'}}));
  }
  ComicDramaQueueService.enqueue(1);
  await vi.waitFor(() => expect(sqlite.prepare("SELECT count(*) AS n FROM comic_drama_tasks WHERE status IN ('done','error')").get()).toEqual({n:4}));
  expect(calls.map(c => [c.model,c.video_length])).toEqual(cases.map(item => [item.model,item.sent]));
  expect(sqlite.prepare('SELECT status,quality_report FROM comic_drama_tasks WHERE id=3').get()).toMatchObject({status:'error',quality_report:expect.stringContaining('5–30')});
});
