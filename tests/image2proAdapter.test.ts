import { expect, it, vi } from 'vitest';
import { submitImage2pro, pollImage2pro, normalizeImage2pro } from '../server/services/image2proAdapter.js';
const c={baseUrl:'https://api.image2pro.top/v1',apiKey:'secret-test-key'}, id='a'.repeat(32), key='order-123456';
it.each([400,401,402,403,404,405,413,415,429])('recognizes documented structured rejection %s',async status=>{
 await expect(submitImage2pro(c,'image',{},key,()=>{},()=>{},async()=>Response.json({error:{message:'具体原因',code:'test'}},{status}))).rejects.toMatchObject({confirmedFailure:true});
});
it.each([409,500,503])('does not refund unknown acceptance %s',async status=>{
 const fetcher=vi.fn(async()=>Response.json({error:{message:'busy'}},{status}));
 await expect(submitImage2pro(c,'video',{},key,()=>{},()=>{},fetcher)).rejects.toMatchObject({confirmedFailure:false});expect(fetcher).toHaveBeenCalledOnce();
});
it('persists logical request and receipt before classifying even a non-2xx task',async()=>{
 const events:string[]=[];await submitImage2pro(c,'image',{},key,()=>events.push('persist request'),value=>events.push(value),async()=>{events.push('send');return Response.json({id,status:'failed'},{status:429});});
 expect(events).toEqual(['persist request','send',id]);
});
it('query HTTP errors preserve the original task and never submit',async()=>{
 const fetcher=vi.fn(async()=>Response.json({error:{message:'暂时不可查'}},{status:503}));
 await expect(pollImage2pro(c,'video',id,fetcher)).rejects.toMatchObject({phase:'query',confirmedFailure:false});
 expect(fetcher.mock.calls[0][0]).toContain('/videos/'+id);expect(fetcher).toHaveBeenCalledOnce();
});
it('refund pending is still pending; terminal failure is independent from query errors',()=>{
 expect(normalizeImage2pro(c,'image',id,{id,status:'failed',accounting_status:'refund_pending',error:{message:'退款中'}}).status).toBe('processing');
 expect(normalizeImage2pro(c,'image',id,{id,status:'failed',accounting_status:'refunded',error:{message:'审核拒绝'}})).toMatchObject({status:'failed',error:expect.stringContaining('审核拒绝')});
});
it('rejects mismatched IDs and unknown states',()=>{
 expect(()=>normalizeImage2pro(c,'video',id,{id:'b'.repeat(32),status:'completed'})).toThrow('编号不一致');
 expect(()=>normalizeImage2pro(c,'video',id,{id,status:'new_state'})).toThrow('未知');
});
