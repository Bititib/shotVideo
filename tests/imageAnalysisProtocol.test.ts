import { afterEach, expect, it, vi } from 'vitest';
import { AIService } from '../server/services/aiService';
const model={id:1,modelId:'gemini-2.5-flash',apiKey:'test-secret'};
afterEach(()=>vi.unstubAllGlobals());
it('recognizes Gemini parameter rejection while retaining its cause',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:400,status:'INVALID_ARGUMENT',message:'Unsupported image format'}},{status:400})));
  await expect(AIService.callGenerateContent(model.modelId,{},model,true)).rejects.toMatchObject({imageOutcome:'rejected',message:expect.stringContaining('Unsupported image format')});
});
it('keeps network loss and unrecognized proxy responses uncertain',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('connection reset')));
  await expect(AIService.callGenerateContent(model.modelId,{},model,true)).rejects.toMatchObject({imageOutcome:'unknown'});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('gateway timeout',{status:504})));
  await expect(AIService.callGenerateContent(model.modelId,{},model,true)).rejects.toMatchObject({imageOutcome:'unknown'});
});
it('does not add image-specific semantics to other analysis callers',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{code:400,status:'INVALID_ARGUMENT',message:'bad request'}},{status:400})));
  try { await AIService.callGenerateContent(model.modelId,{},model); } catch(error:any) { expect(error.imageOutcome).toBeUndefined(); }
});
