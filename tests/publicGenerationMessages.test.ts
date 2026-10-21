import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateVideo } from '../client/src/api/video';
import { generateImage } from '../client/src/api/imageGen';
afterEach(() => vi.unstubAllGlobals());
import { publicGenerationError, publicGenerationEvent, publicCanvasJobMessage } from '../shared/generationMessages';
import { parseDocument } from '../shared/canvasModel';
import { applyGenerationEvent, parseEvent } from '../client/src/canvas/generation';
const raw = '纵横科技提交失败 (400): invalid_parameters: 视频时长不符合当前模型要求，请选择支持的时长后重试';
const safe = 'invalid_parameters: 视频时长不符合当前模型要求，请选择支持的时长后重试';
describe('public generation failure messages', () => {
  it.each(['insufficient credits', 'INSUFFICIENT_CREDITS', 'not enough credits', 'credit balance is insufficient', '积分余额不足', '上游账户余额不足'])
    ('explains upstream credit exhaustion without revealing provider diagnostics: %s', reason => {
      const result = publicGenerationError('私有供应商 https://private.invalid sk-private-key: ' + reason);
      expect(result).toContain(reason);
      expect(result).not.toMatch(/private\.invalid|sk-private-key|私有供应商|联系管理员/);
      expect(publicGenerationError(result)).toBe(result);
    });
  it('keeps uncertain submissions and unrelated insufficient-resource errors distinct', () => {
    expect(publicGenerationError('提交结果待核实：insufficient credits')).toContain('请勿重复提交');
    expect(publicGenerationError('账户余额不足，请充值后重试')).not.toContain('上游积分不足');
    expect(publicGenerationError('insufficient memory')).not.toContain('上游积分不足');
    expect(publicGenerationError('quota exceeded')).not.toContain('上游积分不足');
  });
  it.each(['纵横科技', 'Haya', '自定义私有供应商', 'https://private.invalid?key=sk-test-secret'])('keeps an actionable duration reason without exposing %s', provider => {
    const result=publicGenerationError(provider+' 提交失败 (400): invalid_parameters: 视频时长不符合当前模型要求');
    expect(result).toBe('invalid_parameters: 视频时长不符合当前模型要求');expect(result).not.toContain(provider);expect(publicGenerationError(result)).toBe(result);
  });
  it('preserves unknown diagnostic text while removing provider names and keys', () => {
    const result = publicGenerationError({message:'私有供应商Q: proprietary failure at https://secret.invalid sk-private-key',channel:'私有供应商Q'});
    expect(result).toContain('proprietary failure');
    expect(result).not.toMatch(/私有供应商Q|secret\.invalid|sk-private-key|联系管理员/);
    expect(publicGenerationError(null)).toBe(publicGenerationError('unknown'));
  });
  it('preserves uncertain submission guidance and maps resolution, moderation and references', () => {
    expect(publicGenerationError('Haya 提交结果待核实，禁止重复提交')).toContain('请勿重复提交');
    expect(publicGenerationError('私有供应商 resolution invalid')).toContain('resolution invalid');
    expect(publicGenerationError('纵横科技参考素材数量超限')).toContain('参考素材数量超限');
    expect(publicGenerationError('私有供应商 content_policy violation')).toContain('content_policy violation');
  });
  it('sanitizes new SSE errors without mutating diagnostics or losing IDs and partial results', () => {
    const event={type:'image_error',message:raw,index:2,contentId:12,imageUrl:'/uploads/partial.png'};
    expect(publicGenerationEvent(event)).toEqual({...event,message:safe});expect(event.message).toBe(raw);
    expect(parseEvent('data: '+JSON.stringify(event))).toEqual({...event,message:safe});
    const node=parseDocument({nodes:[{id:'test',kind:'video',x:0,y:0,job:{status:'running',message:'',contentId:12}}]}).nodes[0];
    const partial=applyGenerationEvent(node,event);expect(partial.src).toBe('/uploads/partial.png');expect(partial.job?.contentId).toBe(12);
    const pending=applyGenerationEvent(node,{type:'error',message:raw});expect(pending.job).toMatchObject({status:'running',contentId:12});
  });
  it('does not leak arbitrary provider names from progress events either', () => {
    expect(publicGenerationEvent({type:'status',message:'正在提交 LongXia 视频任务...'}).message).toBe('正在处理任务，请在生成记录查看进度。');
    expect(publicGenerationEvent({type:'status',message:'正在通过 私有供应商Q 提交任务'}).message).not.toContain('私有供应商Q');
    expect(publicGenerationEvent({type:'status',message:'视频生成中 51%'}).message).toBe('视频生成中 51%');
  });
  it.each(['video','image'] as const)('protects %s workbench HTTP and streamed failures before delivering callbacks', async kind => {
    vi.stubGlobal('localStorage',{getItem:()=>null});
    for (const streamed of [false,true]) {
      const body=streamed?'data: '+JSON.stringify({type:'error',message:raw})+'\n\n':JSON.stringify({error:raw});
      vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:streamed?200:400})));
      const callback=vi.fn();
      if(kind==='video') generateVideo({model:'test',prompt:'test'} as any,callback);
      else generateImage({model:'test',prompt:'test'} as any,callback);
      await vi.waitFor(()=>expect(callback).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:safe})));
      expect(JSON.stringify(callback.mock.calls)).not.toContain('纵横科技');
    }
  });
  it.each(['video','image'] as const)('retains the real moderation cause in %s HTTP and SSE failures', async kind => {
    const cause = 'task failed, code: DataInspectionFailed , message: Green net check rejected image (input)';
    vi.stubGlobal('localStorage', {getItem:()=>null});
    for (const streamed of [false,true]) {
      const message = cause + '\nAuthorization: Bearer PRIVATE_CREDENTIAL';
      const body = streamed ? 'data: '+JSON.stringify({type:'error',message})+'\n\n' : JSON.stringify({error:message});
      vi.stubGlobal('fetch', vi.fn(async()=>new Response(body,{status:streamed?200:400})));
      const callback = vi.fn();
      if (kind === 'video') generateVideo({model:'test',prompt:'test'} as any,callback);
      else generateImage({model:'test',prompt:'test'},callback);
      await vi.waitFor(()=>expect(callback).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:expect.stringContaining(cause)})));
      expect(JSON.stringify(callback.mock.calls)).not.toContain('PRIVATE_CREDENTIAL');
      expect(JSON.stringify(callback.mock.calls)).not.toContain('联系管理员');
    }
  });
  it.each([false, true])('shows explicit upstream credit guidance in the image workbench with streaming=%s', async streamed => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const raw = '上游提交失败 (402)：{"error":"insufficient credits","provider":"private-provider"}';
    const body = streamed ? 'data: ' + JSON.stringify({ type:'error', message:raw }) + '\n\n' : JSON.stringify({ error:raw });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status:streamed ? 200 : 502 })));
    const callback = vi.fn(); generateImage({ model:'mj-imagine-1k', prompt:'test' }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ type:'error',
      message:'insufficient credits' })));
    expect(JSON.stringify(callback.mock.calls)).not.toContain('private-provider');
  });
  it('cleans historical canvas failure messages when old documents load while preserving work', () => {
    const node={id:'historical',kind:'video',x:0,y:0,text:'用户提示词',model:'ZH-KKseadanco2.5X',job:{status:'error',contentId:12927,message:raw}};
    const loaded=parseDocument({nodes:[node]});
    expect(loaded.nodes[0]).toMatchObject({id:node.id,text:node.text,model:node.model,job:{status:'error',contentId:12927,message:safe}});
    expect(node.job.message).toBe(raw);expect(publicCanvasJobMessage(node.job)).toBe(safe);
  });
});
