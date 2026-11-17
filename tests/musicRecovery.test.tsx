// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
const mock=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../client/src/api/client',()=>({api:mock}));
import MusicOrderRecovery from '../client/src/components/MusicOrderRecovery';
afterEach(()=>{cleanup();mock.get.mockReset();mock.post.mockReset();});
it('attaches only the original upload receipt from the admin form without a retry request',async()=>{
  const info={id:'job',operation:'upload',state:'review',submissionId:'original-trace',canImportUploadReceipt:true,results:[]};
  mock.get.mockResolvedValue(info);mock.post.mockResolvedValue({...info,state:'completed'});
  const changed=vi.fn();render(<MusicOrderRecovery id="job" onChange={changed}/>);
  fireEvent.change(await screen.findByLabelText(/原上传成功回执/),{target:{value:JSON.stringify({clip_id:'original_clip',status:'complete'})}});
  fireEvent.change(screen.getByLabelText('原单核对依据'),{target:{value:'已核对原请求的上游成功回执'}});
  fireEvent.click(screen.getByRole('button',{name:'回填原成功回执'}));
  await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
  expect(mock.post).toHaveBeenCalledWith('/admin/music/job/recover',{
    originalRequestId:'original-trace',uploadReceipt:{clip_id:'original_clip',status:'complete'},evidence:'已核对原请求的上游成功回执',
  });
  expect(screen.queryByText('重试免费上传')).toBeNull();
});
it('looks up the original voice from the admin form without requiring a new upload or guessed ID',async()=>{
  const info={id:'job',operation:'voice',state:'review',submissionId:'original-trace',canLookupVoice:true,results:[]};
  mock.get.mockResolvedValue(info);mock.post.mockResolvedValue({...info,state:'completed'});
  render(<MusicOrderRecovery id="job" onChange={()=>{}}/>);
  fireEvent.change(await screen.findByLabelText('原单核对依据'),{target:{value:'按原请求编号只读查询音色'}});
  fireEvent.click(screen.getByRole('button',{name:'查询并恢复原订单'}));
  await waitFor(()=>expect(mock.post).toHaveBeenCalledWith('/admin/music/job/recover',{evidence:'按原请求编号只读查询音色'}));
});
