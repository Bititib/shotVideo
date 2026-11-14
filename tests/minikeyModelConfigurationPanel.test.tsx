// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import MinikeyModelConfigurationPanel from '../client/src/components/MinikeyModelConfigurationPanel';
const api=vi.hoisted(()=>({list:vi.fn(),catalog:vi.fn(),save:vi.fn(),preview:vi.fn()}));
vi.mock('../client/src/api/admin',()=>({adminApi:{getMinikeyModelConfigurations:api.list,getMinikeyModelCatalog:api.catalog,saveMinikeyModel:api.save,previewMinikeyModel:api.preview}}));
beforeEach(()=>{
  vi.resetAllMocks();api.list.mockResolvedValue([]);api.catalog.mockResolvedValue([
    {model:'video-new',name:'新视频',kind:'video',maxImages:30,durations:[5,10],resolutions:[],channels:[{id:238,name:'线路 A',prices:{5:3,10:3}}]},
    {model:'suno-new',name:'新音乐',kind:'music',maxImages:0,durations:[],resolutions:[],channels:[]}]);
  api.save.mockImplementation(async(_id,draft)=>({...draft,version:'saved',editable:true}));api.preview.mockResolvedValue({path:'/openapi/v1/videos'});
});
afterEach(cleanup);
it('adds a model with an explicit line and sends editable limits without a channel prefix',async()=>{
  const saved=vi.fn();render(<MinikeyModelConfigurationPanel channelId={7} onClose={vi.fn()} onSaved={saved}/>);
  await waitFor(()=>expect(screen.getByLabelText('本站模型 ID')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('本站模型 ID'),{target:{value:'my-video'}});
  fireEvent.change(screen.getByLabelText('上游型号'),{target:{value:'video-new'}});
  expect(screen.getByLabelText('输出清晰度')).toHaveValue('');
  expect(screen.getByLabelText('参考图片上限')).toHaveValue(1);
  fireEvent.change(screen.getByLabelText('上游线路'),{target:{value:'238'}});
  fireEvent.change(screen.getByLabelText('输出清晰度'),{target:{value:'1080p'}});
  fireEvent.click(screen.getByText('预览请求'));await screen.findByText('本地预览，不会生成或扣费。');
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('校验并保存'));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
  expect(api.save).toHaveBeenCalledWith(7,expect.objectContaining({modelId:'my-video',upstreamModel:'video-new',upstreamChannel:238,limits:expect.objectContaining({resolutions:['1080p']})}),null);
  expect(screen.getByLabelText('本站模型 ID')).toBeDisabled();
});
it('keeps failed edits and asks before abandoning them',async()=>{
  api.save.mockRejectedValue(new Error('配置已变化'));const close=vi.fn();
  render(<MinikeyModelConfigurationPanel channelId={7} onClose={close} onSaved={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByLabelText('本站模型 ID')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('本站模型 ID'),{target:{value:'my-video'}});
  fireEvent.change(screen.getByLabelText('上游型号'),{target:{value:'video-new'}});
  fireEvent.click(screen.getByText('校验并保存'));await screen.findByRole('alert');
  expect(screen.getByLabelText('本站模型 ID')).toHaveValue('my-video');
  fireEvent.click(screen.getByText('添加新模型'));await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByText('继续编辑'));expect(close).not.toHaveBeenCalled();
});
it('does not offer miniKey music for new models',async()=>{
  render(<MinikeyModelConfigurationPanel channelId={7} onClose={vi.fn()} onSaved={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByLabelText('生成类型')).toBeEnabled());
  expect(screen.queryByRole('option',{name:'音乐'})).not.toBeInTheDocument();
  expect(screen.getByText('开放线路')).toBeVisible();
});
