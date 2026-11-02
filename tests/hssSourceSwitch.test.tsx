// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import HssSourceSwitch from '../client/src/components/HssSourceSwitch';
import {adminApi} from '../client/src/api/admin';
import {BB_HSS_SOURCES} from '../shared/bbHssSources';
vi.mock('../client/src/api/admin',()=>({adminApi:{getVideoSources:vi.fn(),switchVideoSource:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const options=Object.entries(BB_HSS_SOURCES).map(([source,v],i)=>({source,label:v.label,channelId:i+1,channelName:'配置渠道'+(i+1),ready:true,upstreamModel:v.upstreamModel,limits:v.limits()}));
const initial={current:{source:'KK',channelId:1},options};
it.each(['bb-2.5-301010','hss-2.5-301010'])('switches %s independently and only displays the confirmed source',async modelId=>{
 vi.mocked(adminApi.getVideoSources).mockResolvedValue(initial);
 let finish!:(v:any)=>void;vi.mocked(adminApi.switchVideoSource).mockImplementation(()=>new Promise(resolve=>finish=resolve));
 render(<HssSourceSwitch modelId={modelId}/>);
 await screen.findByText('当前：KK · 配置渠道1');
 expect(adminApi.getVideoSources).toHaveBeenCalledExactlyOnceWith(modelId);
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'A:2'}});fireEvent.click(screen.getByRole('button',{name:'切换来源'}));
 expect(adminApi.switchVideoSource).toHaveBeenCalledExactlyOnceWith(modelId,'A',2);
 expect(screen.getByText('当前：KK · 配置渠道1')).toBeTruthy();
 finish({...initial,current:{source:'A',channelId:2}});
 await screen.findByText('当前：HUSS 渠道 A · 配置渠道2');await screen.findByText('已保存，仅对新订单生效');
 expect(screen.getByRole('button',{name:'切换来源'}).hasAttribute('disabled')).toBe(true);
 vi.mocked(adminApi.switchVideoSource).mockRejectedValue(new Error('未开放，原配置保留'));
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'B:3'}});fireEvent.click(screen.getByRole('button',{name:'切换来源'}));
 await screen.findByRole('alert');expect(screen.getByText('当前：HUSS 渠道 A · 配置渠道2')).toBeTruthy();
});
it('disables unconfigured sources, shows source-specific limits and never requests a generation',async()=>{
 vi.mocked(adminApi.getVideoSources).mockResolvedValue({...initial,options:options.map(v=>({...v,ready:v.source!=='B'}))});
 render(<HssSourceSwitch/>);await screen.findByText('当前：KK · 配置渠道1');
 expect(screen.getByRole('option',{name:/HUSS 渠道 B/}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'A:2'}});
 expect(screen.getByText(/素材合计最多30个/)).toBeTruthy();
 expect(adminApi.switchVideoSource).not.toHaveBeenCalled();
});
