import { describe, it, expect, vi } from 'vitest';
import { submitMinikey, pollMinikey, normalizeMinikeyTask, buildMinikeyMusic, fetchMinikeyFile } from '../server/services/minikeyAdapter.js';
const c = { baseUrl: 'https://minikey.work', apiKey: 'mk_test' };
const id = '3f2504e04f8941d39a0c0c8b7f2f1a6d';
describe('miniKey independent protocol', () => {
  it('confines file download credentials to the original task endpoint',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{Location:'https://cdn.example/file.mp3'}})).mockResolvedValueOnce(new Response('ID3'));
    await fetchMinikeyFile(c,'music',id,transport);
    expect(transport.mock.calls[0][1].headers.Authorization).toBe('Bearer mk_test');expect(transport.mock.calls[1][1].headers).toBeUndefined();
  });
  it('persists an accepted ID even when response contains an error', async () => {
    const events: string[] = [];
    const transport = vi.fn(async () => { events.push('send'); return Response.json({ id, error: 'later failure' }, { status: 500 }); });
    await submitMinikey(c, 'videos', new FormData(), () => events.push('persist request'), value => events.push(value), transport);
    expect(events).toEqual(['persist request', 'send', id]);
  });
  it.each([400,401,402,413])('recognizes documented rejection %s', async status => {
    await expect(submitMinikey(c, 'videos', {}, () => {}, () => {}, async () => Response.json({ detail: '具体原因 mk_test' }, { status })))
      .rejects.toMatchObject({ confirmedFailure: true, uncertain: false, httpStatus: status });
  });
  it('does not retry a disconnected music submission', async () => {
    const transport = vi.fn(async () => { throw new Error('timeout'); });
    await expect(submitMinikey(c, 'music', {}, () => {}, () => {}, transport)).rejects.toMatchObject({ uncertain: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps query errors separate from generation failure', async () => {
    await expect(pollMinikey(c, 'videos', id, async () => Response.json({ detail: '任务不存在' }, {status:404})))
      .rejects.toMatchObject({ phase: 'query', confirmedFailure: false });
  });
  it('maps explicit video failure and preserves its reason', () => {
    expect(normalizeMinikeyTask(c, 'videos', id, { id, status: 'failed', error: '素材不合规' })).toMatchObject({status:'failed', error:expect.stringContaining('素材不合规')});
  });
  it('does not interpret delivery processing as success', () => {
    expect(normalizeMinikeyTask(c, 'videos', id, {id,status:'processing'})).toMatchObject({status:'processing',resultUrl:''});
  });
  it('rejects contradictory image receipts and mismatched IDs', () => {
    expect(() => normalizeMinikeyTask(c, 'images', id, {task_id:id,state:'failed',is_final:false})).toThrow('冲突');
    expect(() => normalizeMinikeyTask(c, 'music', id, {id:'a'.repeat(32),status:'failed'})).toThrow('编号');
  });
  it('does not silently discard lyrics in instrumental mode', () => {
    expect(() => buildMinikeyMusic({model:'suno-v6',prompt:'主题',mode:'instrumental',lyrics:'歌词'})).toThrow('歌词');
  });
});
