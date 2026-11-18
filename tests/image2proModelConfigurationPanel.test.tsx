// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import Panel from '../client/src/components/ChannelModelConfigurationPanel';
import { defaultRoutingLimits } from '../shared/modelRouting';
const api=vi.hoisted(()=>({list:vi.fn(),catalog:vi.fn(),save:vi.fn(),preview:vi.fn()}));
vi.mock('../client/src/api/admin',()=>({adminApi:{getChannelModelConfigurations:api.list,getAuthorizedChannelModels:api.catalog,saveChannelModelConfiguration:api.save,previewChannelModelRequest:api.preview}}));
const config={models:[],canAdd:true,canSync:true,image2pro:true,version:'v1'};
beforeEach(()=>{vi.resetAllMocks();api.list.mockResolvedValue(config);api.catalog.mockResolvedValue([{id:'text-new',kind:'text'},{id:'image-new',kind:'image',limits:{...defaultRoutingLimits(),resolutions:['auto'],ratios:['auto'],maxImages:0}}]);api.save.mockResolvedValue(config);});
afterEach(cleanup);
it.each(['text','image'])('adds %s via the actual panel without a provider prefix',async kind=>{
 const saved=vi.fn();render(<Panel channelId={34} channelName="QQ-78ai" onClose={vi.fn()} onSaved={saved} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));
 fireEvent.click(screen.getByText('读取已授权的上游型号'));
 await screen.findByRole('option',{name:kind+'-new'});
 fireEvent.change(screen.getByLabelText('上游模型 ID'),{target:{value:kind+'-new'}});
 expect(screen.getByLabelText('模型类型')).toHaveValue(kind==='text'?'文本':'图片');
 if(kind==='text')expect(screen.queryByText('规格与素材')).not.toBeInTheDocument();
 else {expect(screen.getByLabelText('固定分辨率')).toHaveValue('auto');expect(screen.getByLabelText('最多参考图')).toHaveValue(0);}
 fireEvent.submit(document.querySelector('#channel-model-form')!);
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(api.save).toHaveBeenCalledWith(34,expect.objectContaining({modelId:kind+'-new',upstreamModel:kind+'-new',kind}), 'v1');
});
it('retains configuration on a failed authorization check',async()=>{
 api.save.mockRejectedValue(new Error('上游型号未授权'));
 render(<Panel channelId={34} channelName="QQ-78ai" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));fireEvent.click(screen.getByText('读取已授权的上游型号'));await screen.findByRole('option',{name:'image-new'});fireEvent.change(screen.getByLabelText('上游模型 ID'),{target:{value:'image-new'}});
 fireEvent.submit(document.querySelector('#channel-model-form')!);expect(await screen.findByRole('alert')).toHaveTextContent('上游型号未授权');expect(screen.getByLabelText('上游模型 ID')).toHaveValue('image-new');
});
