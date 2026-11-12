import { expect,it } from 'vitest';
import { publicGenerationError,publicGenerationEvent,generationProblemSummary,publicCanvasJobMessage } from '../shared/generationMessages';
import { publicApiDiagnostics } from '../server/services/publicApiDiagnostics';
import { sanitizeContentRoutingForClient } from '../server/services/contentService';
import { upstreamDiagnostic } from '../server/services/upstreamDiagnostic';

it.each(['miniKey','HUSS','Megaby','V6K','HM Studio','智赢','FunAI','Pidoi','MingFei','snumom','LongXia','Haya','MJ','四月天','海底月'])(
  'hides %s in bare errors, streamed status, and historical task cards',name=>{
    const raw=name+' 查询状态未知或终态标记冲突';
    for(const message of [publicGenerationError(raw),publicGenerationEvent({type:'error',message:raw}).message,
      publicGenerationEvent({type:'status',message:'[上游诊断 '+name+' 查询] HTTP 502：'+raw}).message,
      generationProblemSummary(raw),publicCanvasJobMessage({status:'failed',message:raw})]) {
      expect(message.toLowerCase()).not.toContain(name.toLowerCase());expect(message).toContain('查询状态未知或终态标记冲突');
    }
  });
it('hides future adapter names, URLs, keys and upstream identifiers while retaining the actual reason',()=>{
  const raw='[上游诊断 FutureVendor 查询] HTTP 429 code=LIMIT request_id=private-id：素材数量超限 https://private.example/api mk_secret_123 upstream_model=private-model';
  const text=publicGenerationError(raw);
  expect(text).not.toMatch(/FutureVendor|private|mk_secret|上游诊断/);expect(text).toContain('HTTP 429');expect(text).toContain('素材数量超限');
  expect(publicGenerationError(text)).toBe(text);
});
it('protects record and API metadata without changing stored administrator evidence or public result IDs',()=>{
  const raw=upstreamDiagnostic('miniKey','查询',{code:'LIMIT',message:'素材数量超限'},'',429,'a'.repeat(32));
  const item={id:10,status:'processing',resultUrl:'/uploads/result.mp4',metadata:{actualChannel:'minikey',upstreamModel:'vw_private',
    upstreamTaskId:'a'.repeat(32),minikeyCredential:'private-hash',minikeyInitialTask:{secret:'private'},videoId:'a'.repeat(32),
    upstreamQueryError:raw,error:raw,progress:0,billingStatus:'reserved',model:'public-video'}};
  const safe=sanitizeContentRoutingForClient(item);
  expect(JSON.stringify(safe)).not.toMatch(/miniKey|vw_private|private-hash|aaaaaaaa|上游诊断/);
  expect(safe.metadata.upstreamQueryError).toContain('HTTP 429');expect(safe.resultUrl).toBe(item.resultUrl);
  const api=publicApiDiagnostics({id:'task_10',status:'processing',metadata:item.metadata,error:raw});
  expect(JSON.stringify(api)).not.toMatch(/miniKey|private-hash|aaaaaaaa|上游诊断/);expect(api.id).toBe('task_10');
  expect(item.metadata.error).toBe(raw);expect(raw).toContain('miniKey');expect(raw).toContain('a'.repeat(32));
});
