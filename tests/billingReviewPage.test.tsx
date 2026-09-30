// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BillingReviewPage from '../client/src/pages/admin/BillingReviewPage';
import { api } from '../client/src/api/client';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('requires an explicit amount and evidence before sending a reconciliation',async()=>{
  vi.spyOn(api,'get').mockResolvedValue({items:[{id:'r1',amount:5,actual:null,state:'review',context:{userId:1,model:'测试模型'},created_at:'2026-09-30'}],total:1});
  const submit=vi.spyOn(api,'post').mockResolvedValue({state:'settled'});
  render(<BillingReviewPage/>);
  fireEvent.click(await screen.findByRole('button',{name:'核对处理'}));
  const confirm=screen.getByRole('button',{name:'确认结算并退回差额'}) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('确认实收金额'),{target:{value:'2'}});
  fireEvent.change(screen.getByLabelText('上游核对依据'),{target:{value:'上游任务已终止，确认消费两元'}});
  expect(confirm.disabled).toBe(false);fireEvent.click(confirm);
  await waitFor(()=>expect(submit).toHaveBeenCalledWith('/admin/billing-reservations/r1/resolve',{actual:2,note:'上游任务已终止，确认消费两元'}));
});
