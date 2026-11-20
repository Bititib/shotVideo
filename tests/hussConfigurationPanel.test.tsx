// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import Panel from '../client/src/components/ChannelModelConfigurationPanel';
import {hussConfigurationCatalog} from '../shared/hussConfiguration';
const api=vi.hoisted(()=>({list:vi.fn(),catalog:vi.fn(),save:vi.fn(),preview:vi.fn()}));
vi.mock('../client/src/api/admin',()=>({adminApi:{getChannelModelConfigurations:api.list,getAuthorizedChannelModels:api.catalog,saveChannelModelConfiguration:api.save,previewChannelModelRequest:api.preview}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it.each(['bb-2.5-301010-渠道A','Midjourney V8.2'])('loads HUSS %s parameters and saves the appropriate kind',async upstream=>{
 const config={models:[],canAdd:true,canSync:true,huss:true,version:'v1'};
 api.list.mockResolvedValue(config);api.catalog.mockResolvedValue(hussConfigurationCatalog());api.save.mockResolvedValue(config);
 render(<Panel channelId={22} channelName="HUSS" channelType="huss" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));
 fireEvent.click(screen.getByText('读取已授权的上游型号'));
 await screen.findByRole('option',{name:upstream});
 fireEvent.change(screen.getByLabelText('上游模型 ID'),{target:{value:upstream}});
 const image=upstream==='Midjourney V8.2';
 if(!image)fireEvent.change(screen.getByLabelText('本站 API 模型 ID'),{target:{value:'new-video'}});
 expect(screen.getByLabelText('模型类型')).toHaveValue(image?'图片':'视频');
 expect(screen.getByLabelText('可选分辨率')).toHaveValue(image?'1K,2K':'720p');
 expect(screen.getByLabelText('最多参考视频')).toHaveValue(image?0:10);
 fireEvent.submit(document.querySelector('#channel-model-form')!);
 await waitFor(()=>expect(api.save).toHaveBeenCalled());
 expect(api.save.mock.calls[0][1]).toMatchObject({modelId:image?upstream:'new-video',upstreamModel:upstream,kind:image?'image':'video',limits:{maxVideos:image?0:10}});
 expect(api.save.mock.calls[0][1]).not.toHaveProperty('inputPrice');
});

it('shows the full account list including unsupported entries with reasons',async()=>{
 api.list.mockResolvedValue({models:[],canAdd:true,huss:true,version:'v1'});
 const limits=hussConfigurationCatalog().find(e=>e.kind==='video')!.limits;
 api.catalog.mockResolvedValue([...Array.from({length:12},(_,i)=>({id:'authorized-'+i,kind:'video',limits})),{id:'other-protocol',unavailableReason:'未返回统一视频能力'}]);
 render(<Panel channelId={22} channelName="HUSS" channelType="huss" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));fireEvent.click(screen.getByText('读取已授权的上游型号'));
 expect(await screen.findByRole('option',{name:'authorized-11'})).toBeEnabled();
 expect(screen.getByRole('option',{name:'other-protocol（暂不可配置）'})).toBeDisabled();
 expect(screen.getByText('other-protocol：未返回统一视频能力')).toBeInTheDocument();
 expect(screen.getByText('已授权 13 个型号，其中 12 个具备可配置协议。')).toBeInTheDocument();
});
