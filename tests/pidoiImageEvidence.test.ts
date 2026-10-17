import { expect, it, vi } from 'vitest';
import { pidoiTaskEvidence, restorePidoiJobs } from '../server/services/pidoiImageEvidence';
import { submitPidoiImage, pollPidoiImage } from '../server/services/pidoiImageAdapter';
const channel = { baseUrl: 'https://pidoi.com', apiKey: 'test-only-key' };
it('extracts nested and truncated task JSON, not request IDs or prompt text', () => {
  expect(pidoiTaskEvidence({error:{message:JSON.stringify({id:'task_nested',status:'queued',task_url:'/v1/videos/task_nested'})}})).toMatchObject({taskId:'task_nested',pollPath:'/v1/videos/task_nested'});
  expect(pidoiTaskEvidence('Pidoi 图片提交失败 (502)：{"id":"task_truncated","task_ur')).toMatchObject({taskId:'task_truncated'});
  expect(pidoiTaskEvidence({request_id:'trace',prompt:'{"task_id":"task_fake"}'})).toBeUndefined();
  expect(pidoiTaskEvidence('{"task_id":"task_partial')).toBeUndefined();
  expect(pidoiTaskEvidence({task_id:'../secret'})).toBeUndefined();
});
it.each(['https://evil.test/v1/videos/task_saved','//evil.test/v1/videos/task_saved','/v1/videos/task_other','/v1/videos/task_saved/content','/v1/videos/task_saved?key=1'])('never follows untrusted status path %s', async task_url => {
  const evidence = pidoiTaskEvidence({task_id:'task_saved', task_url});
  expect(evidence?.pollPath).toBeUndefined();
  const fetcher=vi.fn().mockResolvedValue(Response.json({code:'success',data:{task_id:'task_saved',status:'IN_PROGRESS'}}));
  await pollPidoiImage(channel,'task_saved',fetcher,task_url);
  expect(fetcher).toHaveBeenCalledWith('https://pidoi.com/v1/image/generations/task_saved',expect.objectContaining({method:'GET',redirect:'error'}));
});
it('keeps accepted 502 submissions and follows only their validated GET status path', async () => {
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:{message:JSON.stringify({task_id:'task_saved',status:'queued',task_url:'/v1/images/generations/task_saved'})}},{status:502}))
    .mockResolvedValueOnce(Response.json({id:'task_saved',status:'failed',error:{message:'Rejected'}}));
  const task=await submitPidoiImage(channel,{prompt:'cat'},fetcher);
  expect(task).toMatchObject({taskId:'task_saved',status:'processing',pollPath:'/v1/images/generations/task_saved'});
  expect(await pollPidoiImage(channel,task.taskId,fetcher,task.pollPath)).toMatchObject({status:'failed',error:'Rejected'});
  expect(fetcher.mock.calls.map(c=>c[1].method)).toEqual(['POST','GET']);
});
it('restores missing jobs without treating request traces as pollable tasks or duplicating slots', () => {
  const m={count:2,upstreamResponses:[{id:'request_trace'},{id:'task_second'}],submissionFailure:{index:0,message:'{"task_id":"task_first","status":"queued"}'},pidoiImageJobs:[]};
  const jobs=restorePidoiJobs(m);
  expect(jobs.map(j=>[j.index,j.taskId])).toEqual([[0,'task_first'],[1,'task_second']]);
  expect(restorePidoiJobs({...m,pidoiImageJobs:jobs})).toEqual(jobs);
});
it('does not finalize a different returned task or treat a query HTTP failure as a generation failure',async()=>{
  await expect(pollPidoiImage(channel,'task_expected',vi.fn().mockResolvedValue(Response.json({code:'success',data:{task_id:'task_other',status:'FAILURE'}})))).rejects.toThrow('不一致');
  await expect(pollPidoiImage(channel,'task_expected',vi.fn().mockResolvedValue(Response.json({id:'task_expected',status:'failed'},{status:502})))).rejects.toMatchObject({confirmedFailure:false});
});
