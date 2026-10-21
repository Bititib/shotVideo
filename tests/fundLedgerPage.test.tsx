// @vitest-environment jsdom
import React from 'react';import {afterEach,it,expect,vi} from 'vitest';import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
vi.mock('../client/src/api/client',()=>({api:{get:vi.fn()}}));
import {api} from '../client/src/api/client';import FundLedgerPage from '../client/src/pages/admin/FundLedgerPage';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('shows a debit of exactly one yuan as a debit, filters and never offers a balance mutation',async()=>{vi.mocked(api.get).mockResolvedValue({items:[{id:1,account_type:'user',account_id:3,account_name:'测试用户',kind:'charge',delta:-1,balance_before:2,balance_after:1,created_at:'2026-10-19 00:00:00',actor_id:null,content_id:99}],total:1,startedAt:'2026-10-19 00:00:00'});render(<FundLedgerPage/>);expect(await screen.findByText('-1.00')).toBeTruthy();expect(screen.queryByText('不限额')).toBeNull();fireEvent.change(screen.getByLabelText('账户类型'),{target:{value:'user'}});fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-10-19'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));await waitFor(()=>expect(vi.mocked(api.get).mock.lastCall?.[0]).toContain('from=2026-10-19'));expect(screen.queryByRole('button',{name:'充值'})).toBeNull();});
it('shows access errors without leaking stale table rows',async()=>{vi.mocked(api.get).mockRejectedValue(new Error('需要超级管理员权限'));render(<FundLedgerPage/>);expect(await screen.findByRole('alert')).toHaveProperty('textContent','需要超级管理员权限');});
it('defaults to wallet only, exposes task IDs and keeps repeated real charges visible',async()=>{
  const task={id:14007,model:'wan3.0-video-prime',status:'processing',userId:98,upstreamIds:['task_example']};
  const wallet={id:1,account_type:'user',account_id:98,account_name:'用户',user_id:98,user_name:'用户',kind:'charge',delta:-3.9,balance_before:100,balance_after:96.1,created_at:'2026-10-21 00:00:00',actor_id:null,content_id:14007,tasks:[task]};
  const usage={...wallet,id:3,account_type:'token_usage',account_id:30,delta:3.9,balance_before:10,balance_after:13.9};
  vi.mocked(api.get).mockImplementation(async(url:any)=>({items:String(url).includes('scope=usage')?[usage]:[wallet,{...wallet,id:2,balance_before:96.1,balance_after:92.2}],total:String(url).includes('scope=usage')?1:2}) as any);
  render(<FundLedgerPage/>);
  expect(await screen.findAllByText('-3.90')).toHaveLength(2);
  expect(screen.queryByText('+3.90')).toBeNull();
  expect(screen.getByRole('tab',{name:'钱包收支'}).getAttribute('aria-selected')).toBe('true');
  expect(vi.mocked(api.get).mock.calls[0][0]).toContain('scope=wallet');
  expect(screen.getAllByText('上游：task_example')).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button',{name:'筛选任务 14007'})[0]);
  await waitFor(()=>expect(vi.mocked(api.get).mock.lastCall?.[0]).toContain('contentId=14007'));
  fireEvent.click(screen.getByRole('tab',{name:'Token 用量'}));
  expect(await screen.findByText('+3.90')).toBeTruthy();
  expect(screen.queryByText('-3.90')).toBeNull();
  expect(vi.mocked(api.get).mock.lastCall?.[0]).toContain('contentId=14007');
  fireEvent.keyDown(screen.getByRole('tab',{name:'Token 用量'}),{key:'ArrowLeft'});
  await waitFor(()=>expect(screen.getByRole('tab',{name:'钱包收支'}).getAttribute('aria-selected')).toBe('true'));
});
it('shows a batch charge once with an expandable task group instead of repeating the amount',async()=>{
  vi.mocked(api.get).mockResolvedValue({items:[{id:9,account_type:'user',account_id:98,account_name:'用户',user_id:98,kind:'charge',delta:-7.8,balance_before:100,balance_after:92.2,created_at:'2026-10-21 00:00:00',actor_id:null,content_id:null,tasks:[
    {id:1,model:'wan',status:'processing',userId:98,upstreamIds:[]},{id:2,model:'wan',status:'processing',userId:98,upstreamIds:[]}
  ]}],total:1});
  render(<FundLedgerPage/>);
  expect(await screen.findByText('2 个任务（批次汇总）')).toBeTruthy();
  expect(screen.getAllByText('-7.80')).toHaveLength(1);
});
it('filters Token usage by owner and distinguishes usage increases/refunds from wallet balances',async()=>{
  vi.mocked(api.get).mockResolvedValue({items:[
    {id:2,account_type:'token_usage',account_id:30,account_name:'无限业务Token',user_id:98,user_name:'测试用户',kind:'charge',delta:3.9,balance_before:10,balance_after:13.9,created_at:'2026-10-21 00:00:00',actor_id:null,content_id:14001},
    {id:3,account_type:'token_usage',account_id:30,account_name:'无限业务Token',user_id:98,user_name:'测试用户',kind:'refund',delta:-3.9,balance_before:13.9,balance_after:10,created_at:'2026-10-21 00:01:00',actor_id:null,content_id:14001}
  ],total:2,usageStartedAt:'2026-10-21 00:00:00'});
  render(<FundLedgerPage/>);
  fireEvent.click(screen.getByRole('tab',{name:'Token 用量'}));
  expect(await screen.findByText('+3.90')).toBeTruthy();
  expect(screen.getByText('-3.90')).toBeTruthy();
  expect(screen.getByText('用量增加（扣费 / 预扣）')).toBeTruthy();
  expect(screen.getByText('用量减少（退款）')).toBeTruthy();
  expect(screen.getByText('10.00 → 13.90')).toBeTruthy();
  expect(screen.queryByText('不限额')).toBeNull();
  expect(screen.getAllByText('测试用户 #98')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('用户 ID'),{target:{value:'98'}});
  fireEvent.change(screen.getByLabelText('账户类型'),{target:{value:'token_usage'}});
  fireEvent.change(screen.getByLabelText('变动类型'),{target:{value:'refund'}});
  fireEvent.click(screen.getByRole('button',{name:'查询'}));
  await waitFor(()=>expect(vi.mocked(api.get).mock.lastCall?.[0]).toContain('userId=98'));
  expect(vi.mocked(api.get).mock.lastCall?.[0]).toContain('accountType=token_usage');
  expect(vi.mocked(api.get).mock.lastCall?.[0]).toContain('kind=refund');
  fireEvent.click(screen.getByRole('button',{name:'清空'}));
  await waitFor(()=>expect(vi.mocked(api.get).mock.lastCall?.[0]).not.toContain('userId=98'));
});
