import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createZhiyingVideo, fetchZhiyingVideoContent, pollZhiyingVideo, prepareZhiyingVideo } from '../server/services/zhiyingVideoAdapter.js';
import { downloadPublicMedia } from '../server/services/publicImageDownload.js';
import { probeVideoBufferDuration } from '../server/services/videoDurationProbe.js';
import { signedMediaUrl } from '../server/services/mediaSignature.js';

vi.mock('../server/services/publicImageDownload.js', () => ({ downloadPublicMedia: vi.fn() }));
vi.mock('../server/services/videoDurationProbe.js', () => ({ probeVideoBufferDuration: vi.fn() }));
const channel = { baseUrl: 'https://zhiyingai.xyz/v1', apiKey: 'example-private-channel-key', type: 'zhiying' };
const createData = { model: 'sd-2.5-fullblood-line2' as const, prompt: '海浪', duration: 30, resolution: '720p', aspect_ratio: '16:9' };
const id = 'video_original_123', key = 'request-original-123';
const request = vi.fn<typeof fetch>();
const json = (raw: unknown, status = 200) => Response.json(raw, { status });
const create = () => createZhiyingVideo(channel, createData, key);
const cdn = 'https://cdn.example.test/asset.mp4?signature=x&expires=17';
const img = Buffer.from([137,80,78,71,13,10,26,10,0]);
const video = Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109]);
const inline = (mime: string, buf: Buffer) => 'data:' + mime + ';base64,' + buf.toString('base64');

beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', request); });
afterEach(() => vi.unstubAllGlobals());

it('keeps same key and exactly the same JSON for an idempotent replay', async () => {
  request.mockImplementation(async () => json({ id, status:'queued', object:'video', cost_points:498 }, 202));
  await expect(create()).resolves.toMatchObject({taskId:id, status:'pending', upstreamStatus:'queued', costPoints:498});
  await create();
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe('https://zhiyingai.xyz/v1/generations');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(key);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + channel.apiKey);
    expect(JSON.parse(String(init?.body))).toEqual(createData);
  }
});
it('sends only the two configured models to the configured official host', async () => {
  await expect(createZhiyingVideo(channel, {...createData, model:'wan3.0' as any}, key)).rejects.toMatchObject({confirmedFailure:true});
  await expect(createZhiyingVideo(channel, {...createData, model:'SD-特价' as any}, key)).rejects.toMatchObject({confirmedFailure:true});
  await expect(createZhiyingVideo(channel, createData, 'short')).rejects.toMatchObject({confirmedFailure:true});
  await expect(createZhiyingVideo({...channel,baseUrl:'https://example.test'},createData,key)).rejects.toThrow('渠道地址');
  expect(request).not.toHaveBeenCalled();
});
it.each(['review','processing','queued','created','brand_new_state'])('preserves the receipt when state=%s', async status => {
  request.mockResolvedValueOnce(json({id, status}, 202));
  const task = await create();
  expect(task.taskId).toBe(id);
  expect(task.upstreamStatus).toBe(status);
  expect(['pending','processing']).toContain(task.status);
});
it('keeps terminal evidence and sanitizes errors including key, link and cookie', async () => {
  const body = { id, status:'failed', refunded:false, charged_points:498, refunded_points:0,
    error:{code:'invalid_reference',type:'validation',message:'素材错误 '+cdn+' '+channel.apiKey+' Cookie: exposed', request_id:'req_123'} };
  request.mockResolvedValueOnce(json(body,202));
  const task = await create();
  expect(task).toMatchObject({taskId:id,status:'failed',upstreamStatus:'failed',refunded:false,chargedPoints:498,refundedPoints:0});
  for (const text of ['素材错误','invalid_reference','req_123','202']) expect(task.error).toContain(text);
  for (const text of [cdn, channel.apiKey, 'exposed']) expect(task.error).not.toContain(text);
});
it('keeps query failures separate from explicit task failure and from submission rejection', async () => {
  const denial = { error:{code:'insufficient_points',message:'积分不足',request_id:'rid_77'} };
  request.mockResolvedValueOnce(json(denial,402));
  await expect(create()).rejects.toMatchObject({confirmedFailure:true,status:402,code:'insufficient_points',requestId:'rid_77'});
  request.mockResolvedValueOnce(json(denial,402));
  await expect(pollZhiyingVideo(channel,id)).rejects.toMatchObject({confirmedFailure:false,status:402});
  request.mockResolvedValueOnce(json({id,status:'failed',...denial}));
  await expect(pollZhiyingVideo(channel,id)).resolves.toMatchObject({status:'failed',error:expect.stringContaining('积分不足')});
  request.mockResolvedValueOnce(json({id,status:'canceled'}));
  await expect(pollZhiyingVideo(channel,id)).resolves.toMatchObject({status:'failed',upstreamStatus:'canceled'});
});
it('retains the reservation on conflict, ambiguous response, gateway HTML, or disconnected submit', async () => {
  for (const response of [json({error:{code:'conflict',message:'不同参数'}},409),json({error:{code:'internal_error',message:'超时'}},500),
    json({error:{code:'unknown',message:'未返回任务'}},200),json({},202),new Response('<html>gateway</html>',{status:400})]) {
    request.mockResolvedValueOnce(response);
    await expect(create()).rejects.toMatchObject({confirmedFailure:false});
  }
  request.mockRejectedValueOnce(new TypeError('fetch failed'));
  await expect(create()).rejects.toMatchObject({confirmedFailure:false});
});
it('retains Retry-After and rejects wrong identities and model in queries', async () => {
  request.mockResolvedValueOnce(Response.json({error:{code:'busy',message:'忙'}}, {status:429,headers:{'Retry-After':'15'}}));
  await expect(pollZhiyingVideo(channel,id)).rejects.toMatchObject({status:429,retryAfterMs:15_000,confirmedFailure:false});
  for (const row of [{id:'video_wrong',status:'failed'},{id,status:'failed',model:'sd-2.5-fullblood'},{id,status:'failed',object:'image'}]) {
    request.mockResolvedValueOnce(json(row));
    await expect(pollZhiyingVideo(channel,id,'sd-2.5-fullblood-line2')).rejects.toMatchObject({confirmedFailure:false});
  }
});
it('preserves returned signed URLs and does not invent one when absent', async () => {
  request.mockResolvedValueOnce(json({id,status:'succeeded',result_url:cdn}));
  expect((await pollZhiyingVideo(channel,id)).resultUrl).toBe(cdn);
  request.mockResolvedValueOnce(json({id,status:'succeeded',result_url:'/v1/generations/'+id+'/content?token=a%2Fb'}));
  expect((await pollZhiyingVideo(channel,id)).resultUrl).toBe('https://zhiyingai.xyz/v1/generations/'+id+'/content?token=a%2Fb');
  for (const url of [undefined,'/uploads/private.mp4','file:///tmp/file','https://user:secret@evil.test/a']) {
    request.mockResolvedValueOnce(json({id,status:'succeeded',result_url:url}));
    const task = await pollZhiyingVideo(channel,id);
    expect(task.status).toBe('completed');
    expect(task.resultUrl).toBeUndefined();
  }
});
it('refreshes an expired signed file by querying precisely the original task without authorizing the CDN', async () => {
  const fresh = cdn + '&new=1';
  vi.mocked(downloadPublicMedia).mockRejectedValueOnce(Object.assign(new Error('expired'), {httpStatus:403})).mockResolvedValueOnce(video);
  request.mockResolvedValueOnce(json({id,object:'video',status:'succeeded',result_url:fresh}));
  expect(await fetchZhiyingVideoContent(channel,id,cdn)).toEqual(video);
  expect(request.mock.calls.map(([url]) => url)).toEqual(['https://zhiyingai.xyz/v1/generations/'+id]);
  expect(vi.mocked(downloadPublicMedia).mock.calls.map(([url]) => url)).toEqual([cdn,fresh]);
  expect(JSON.stringify(vi.mocked(downloadPublicMedia).mock.calls)).not.toContain(channel.apiKey);
});
it('uploads sequentially, preserves order, detects video seconds from exact uploaded bytes on line1', async () => {
  const files: Array<{type:string;bytes:Buffer}> = [];
  request.mockImplementation(async (url, init) => {
    expect(url).toBe('https://zhiyingai.xyz/v1/files');
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
    const file = (init?.body as FormData).get('file') as Blob;
    files.push({ type:file.type, bytes:Buffer.from(await file.arrayBuffer()) });
    return json({id:'file_'+files.length},201);
  });
  vi.mocked(downloadPublicMedia).mockResolvedValueOnce(img);
  vi.mocked(probeVideoBufferDuration).mockResolvedValueOnce(1.234);
  const image2 = Buffer.concat([img, Buffer.from([5])]);
  const audio = Buffer.from('ID3test');
  const prompt = '参考图片2 与参考图片1，参考视频1，参考音频1';
  const payload = await prepareZhiyingVideo(channel, {model:'sd-2.5-fullblood',prompt,input:{
    images:['https://assets.example/x.png',inline('image/png',image2)],videos:[inline('video/mp4',video)],
    audios:[inline('audio/mpeg',audio)]}});
  expect(payload).toMatchObject({model:'sd-2.5-fullblood', duration:30, resolution:'720p', aspect_ratio:'16:9',
    reference_images:['file_1','file_2'],reference_videos:['file_3'],reference_audios:['file_4'],reference_video_duration_total:1.234});
  expect(files.map(x => x.bytes)).toEqual([img,image2,video,audio]);
  expect(payload.prompt).toBe('@Image2 与@Image1，@Video1，@Audio1');
  request.mockResolvedValueOnce(json({id, status:'queued'},202));
  await createZhiyingVideo(channel, payload, key);
  expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body))).toMatchObject({prompt:'@Image2 与@Image1，@Video1，@Audio1',
    reference_images:['file_1','file_2'],reference_videos:['file_3'],reference_audios:['file_4']});
  expect(probeVideoBufferDuration).toHaveBeenCalledWith(video);
  await expect(prepareZhiyingVideo(channel,{model:'sd-2.5-fullblood-line2',prompt:'test',input:{videos:[inline('video/mp4',video)]}})).resolves.not.toHaveProperty('reference_video_duration_total');
  expect(probeVideoBufferDuration).toHaveBeenCalledTimes(1);
});
it('rejects unauthorized local files, user-supplied upstream file IDs and wrong media before generation', async () => {
  for (const source of ['/uploads/private.png','file_owned_by_another_user',inline('image/png',video)]) {
    await expect(prepareZhiyingVideo(channel,{model:'sd-2.5-fullblood-line2',prompt:'test',input:{images:[source]}},{userId:12})).rejects.toMatchObject({confirmedFailure:true});
  }
  await expect(prepareZhiyingVideo(channel,{model:'sd-2.5-fullblood-line2',prompt:'test',input:{videos:Array(11).fill(inline('video/mp4',video))}})).rejects.toThrow('视频最多');
  expect(request).not.toHaveBeenCalled(); expect(downloadPublicMedia).not.toHaveBeenCalled();
});
it('requires upload acceptance and does not forward an ambiguous returned document or ID', async () => {
  for (const response of [json({id:'file_a'},200),json({ticket:'tmp'},201),json({id:'file_a',file_id:'file_b'},201),json({id:'file_a',error:{code:'failed',message:'未验收'}},201)]) {
    request.mockResolvedValueOnce(response);
    await expect(prepareZhiyingVideo(channel,{model:'sd-2.5-fullblood-line2',prompt:'test',input:{images:[inline('image/png',img)]}})).rejects.toMatchObject({confirmedFailure:true});
  }
  expect(request.mock.calls.every(([url]) => url === 'https://zhiyingai.xyz/v1/files')).toBe(true);
});

it('recognizes the documented authentication error and treats a competing task as an original receipt', async () => {
  const denied = { error: {code:'invalid_api_key',message:'API Key无效或已撤销。',type:'invalid_request_error',request_id:'req_auth'} };
  request.mockResolvedValueOnce(json(denied,401));
  await expect(create()).rejects.toMatchObject({status:401,code:'invalid_api_key',confirmedFailure:true});
  request.mockResolvedValueOnce(json({id,object:'video',status:'processing',...denied},500));
  await expect(create()).resolves.toMatchObject({taskId:id,status:'pending'});
  request.mockResolvedValueOnce(json({id,object:'video',status:'processing',...denied},409));
  await expect(create()).rejects.toMatchObject({status:409,confirmedFailure:false});
});
it.each([{file_id:'file_valid'},{id:'file_valid',file_id:'file_valid'}])('uses a single unambiguous file identity', async envelope => {
  request.mockResolvedValueOnce(json(envelope,201));
  await expect(prepareZhiyingVideo(channel,{model:'sd-2.5-fullblood-line2',prompt:'test',input:{images:[inline('image/png',img)]}})).resolves.toMatchObject({reference_images:['file_valid']});
});

it('reads a signed local upload without publishing it or treating another host as a local file', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiying-owned-media-'));
  const local = '/uploads/owned.png';
  const base = 'https://app.example.test';
  await fs.mkdir(path.join(work,'data','uploads'), {recursive:true});
  await fs.writeFile(path.join(work,'data','uploads','owned.png'),img);
  const oldCwd = vi.spyOn(process,'cwd').mockReturnValue(work);
  vi.stubEnv('BACKEND_URL', base);
  try {
    const signed = signedMediaUrl(local,base);
    const prepare = (url: string) => prepareZhiyingVideo(channel,{model:'sd-2.5-fullblood-line2',prompt:'test',publicBaseUrl:base,input:{images:[url]}},{userId:42});
    await expect(prepare(local)).rejects.toThrow('无权');
    request.mockResolvedValueOnce(json({id:'file_correct'},201));
    expect((await prepare(signed)).reference_images).toEqual(['file_correct']);
    expect(downloadPublicMedia).not.toHaveBeenCalled();
    vi.mocked(downloadPublicMedia).mockRejectedValueOnce(new Error('公网不可访问'));
    await expect(prepare(signed.replace(base,'https://other.example.test'))).rejects.toThrow('公网不可访问');
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    oldCwd.mockRestore(); vi.unstubAllEnvs();
    await fs.rm(work,{recursive:true,force:true});
  }
});
