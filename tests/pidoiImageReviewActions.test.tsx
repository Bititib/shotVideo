// @vitest-environment jsdom
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { PidoiImageReviewActions } from '../client/src/components/PidoiImageReviewActions';
vi.mock('../client/src/api/admin',()=>({adminApi:{recheckPidoiImage:vi.fn(),confirmPidoiImageFailure:vi.fn()}}));
import { adminApi } from '../client/src/api/admin';
const props={id:13186,status:'review',cost:0.22,metadata:{imageProtocol:'pidoi-async-v1'},hasResult:false,onResolved:vi.fn().mockResolvedValue(undefined)};
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(window,'confirm').mockReturnValue(true);vi.spyOn(window,'prompt').mockReturnValue('已核对上游任务，无成功图片');});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('shows persisted pause reason on reopening without requiring another query',()=>{
  render(<PidoiImageReviewActions {...props} metadata={{...props.metadata,pidoiRecoveryPauseReason:'上游查询接口返回 404，已暂停自动查询'}}/>);
  expect(screen.getByRole('status').textContent).toContain('404，已暂停自动查询');
  expect(adminApi.recheckPidoiImage).not.toHaveBeenCalled();
});
it('offers querying and explicit refund separately, refreshes resolved data',async()=>{
  vi.mocked(adminApi.recheckPidoiImage).mockResolvedValue({message:'已查询原任务'});
  render(<PidoiImageReviewActions {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'查询原任务'}));
  await screen.findByText('已查询原任务');expect(adminApi.confirmPidoiImageFailure).not.toHaveBeenCalled();
  vi.mocked(adminApi.confirmPidoiImageFailure).mockResolvedValue({refundedAmount:0.22,alreadyResolved:false});
  fireEvent.click(screen.getByRole('button',{name:'确认失败并退款'}));
  await screen.findByText('已退回 ¥0.22');
  expect(adminApi.confirmPidoiImageFailure).toHaveBeenCalledExactlyOnceWith(13186,'已核对上游任务，无成功图片');
  expect(props.onResolved).toHaveBeenCalledTimes(2);
});
it('cancelled confirmation or inadequate evidence never sends a refund',()=>{
  render(<PidoiImageReviewActions {...props}/>);
  vi.mocked(window.confirm).mockReturnValue(false);
  fireEvent.click(screen.getByRole('button',{name:'确认失败并退款'}));
  expect(window.prompt).not.toHaveBeenCalled();
  vi.mocked(window.confirm).mockReturnValue(true);vi.mocked(window.prompt).mockReturnValue('短');
  fireEvent.click(screen.getByRole('button',{name:'确认失败并退款'}));
  expect(screen.getByText('请填写 6–500 字的核实依据')).toBeTruthy();
  expect(adminApi.confirmPidoiImageFailure).not.toHaveBeenCalled();
});
it('disables repeated actions while the network call is pending',async()=>{
  let finish!: (value:any)=>void;
  vi.mocked(adminApi.confirmPidoiImageFailure).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  render(<PidoiImageReviewActions {...props}/>);
  const button=screen.getByRole('button',{name:'确认失败并退款'}) as HTMLButtonElement;
  fireEvent.click(button);fireEvent.click(button);expect(button.disabled).toBe(true);
  expect(adminApi.confirmPidoiImageFailure).toHaveBeenCalledOnce();
  finish({refundedAmount:0.22,alreadyResolved:false});await waitFor(()=>expect(button.disabled).toBe(false));
});
it.each([{hasResult:true},{status:'processing'},{metadata:{imageProtocol:'pidoi-async-v1',pidoiImageJobs:[{status:'completed'}]}}])('does not offer full refunds for active or successful records %j',patch=>{
  render(<PidoiImageReviewActions {...props} {...patch}/>);
  expect(screen.queryByRole('button',{name:'确认失败并退款'})).toBeNull();
});
