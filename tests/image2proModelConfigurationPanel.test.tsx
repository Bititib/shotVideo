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
 else {expect(screen.getByLabelText('可选分辨率')).toHaveValue('auto');expect(screen.getByLabelText('最多参考图')).toHaveValue(0);}
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

it('saves multiple image resolutions, ratios and reference images from the panel',async()=>{
 render(<Panel channelId={34} channelName="QQ-78ai" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));fireEvent.click(screen.getByText('读取已授权的上游型号'));await screen.findByRole('option',{name:'image-new'});fireEvent.change(screen.getByLabelText('上游模型 ID'),{target:{value:'image-new'}});
 fireEvent.change(screen.getByLabelText('可选分辨率'),{target:{value:'1K,2K'}});fireEvent.change(screen.getByLabelText('可选比例'),{target:{value:'1:1,3:2,16:9'}});fireEvent.change(screen.getByLabelText('最多参考图'),{target:{value:'4'}});
 fireEvent.submit(document.querySelector('#channel-model-form')!);
 await waitFor(()=>expect(api.save).toHaveBeenCalledWith(34,expect.objectContaining({kind:'image',limits:expect.objectContaining({resolutions:['1K','2K'],ratios:['1:1','3:2','16:9'],maxImages:4})}),'v1'));
});

it('shows evidence and applies queried defaults only on explicit click for existing models',async()=>{
 const limits={...defaultRoutingLimits(),resolutions:['2K'],ratios:['1:1'],maxImages:1};
 api.list.mockResolvedValue({...config,models:[{modelId:'image-new',upstreamModel:'image-new',displayName:'Existing',capabilities:['image'],limits,enabled:true,editable:true}]});
 api.catalog.mockResolvedValue([{id:'image-new',kind:'image',limits:{...limits,resolutions:['4K'],maxImages:6},imageEvidence:{checkedAt:'2026-11-19T00:00:00Z',notes:['分辨率：官网默认值 4K；完整可选范围未公布','参考图：官网限制 6 张']}}]);
 render(<Panel channelId={34} channelName="QQ-78ai" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('读取已授权的上游型号'));
 expect(await screen.findByText('分辨率：官网默认值 4K；完整可选范围未公布')).toBeInTheDocument();
 expect(screen.getByLabelText('可选分辨率')).toHaveValue('2K');expect(api.save).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('填入查询参数'));
 expect(screen.getByLabelText('可选分辨率')).toHaveValue('4K');expect(screen.getByLabelText('最多参考图')).toHaveValue(6);
 fireEvent.submit(document.querySelector('#channel-model-form')!);
 await waitFor(()=>expect(api.save).toHaveBeenCalledWith(34,expect.objectContaining({limits:expect.objectContaining({resolutions:['4K'],maxImages:6})}),'v1'));
});

it('displays upstream zero/missing prices separately and never includes them in save payload',async()=>{
 const pricing={textToImage:0,imageToImage:null,unit:'上游 API 积分 / 张',checkedAt:'2026-11-19T10:00:00Z',source:'当前渠道 Key 的 /v1/models 授权目录'};
 api.catalog.mockResolvedValue([{id:'image-new',kind:'image',limits:{...defaultRoutingLimits(),resolutions:['auto'],ratios:['auto']},upstreamPricing:pricing}]);
 render(<Panel channelId={34} channelName="QQ-78ai" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));fireEvent.click(screen.getByText('读取已授权的上游型号'));await screen.findByRole('option',{name:'image-new'});fireEvent.change(screen.getByLabelText('上游模型 ID'),{target:{value:'image-new'}});
 expect(screen.getByText('文生图价格').nextElementSibling).toHaveTextContent('0');expect(screen.getByText('图生图价格').nextElementSibling).toHaveTextContent('未公布');expect(screen.getByText(pricing.checkedAt)).toBeInTheDocument();expect(screen.getByText(pricing.unit)).toBeInTheDocument();
 fireEvent.submit(document.querySelector('#channel-model-form')!);await waitFor(()=>expect(api.save).toHaveBeenCalled());expect(api.save.mock.calls[0][1]).not.toHaveProperty('upstreamPricing');
});
