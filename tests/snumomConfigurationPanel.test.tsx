// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import Panel from '../client/src/components/ChannelModelConfigurationPanel';
const api=vi.hoisted(()=>({list:vi.fn(),catalog:vi.fn(),save:vi.fn(),preview:vi.fn()}));
vi.mock('../client/src/api/admin',()=>({adminApi:{getChannelModelConfigurations:api.list,getAuthorizedChannelModels:api.catalog,saveChannelModelConfiguration:api.save,previewChannelModelRequest:api.preview}}));
afterEach(cleanup);
it('snumom panel saves duration, material caps and billing policy without any sale price',async()=>{
 const config={models:[],canAdd:true,canSync:true,protocol:'snumom',version:'v1'};
 api.list.mockResolvedValue(config);api.catalog.mockResolvedValue([{id:'new-snumom-video'}]);api.save.mockResolvedValue(config);
 render(<Panel channelId={14} channelName="snumom" onClose={vi.fn()} onSaved={vi.fn()} onManage={vi.fn()}/>);
 fireEvent.click(await screen.findByText('添加新模型'));fireEvent.click(screen.getByText('读取已授权的上游型号'));
 await screen.findByRole('option',{name:'new-snumom-video'});
 fireEvent.change(screen.getByLabelText('上游模型 ID'),{target:{value:'new-snumom-video'}});
 fireEvent.change(screen.getByLabelText('可选分辨率'),{target:{value:'720p,1080p'}});
 fireEvent.change(screen.getByLabelText('可选比例'),{target:{value:'16:9,9:16'}});
 fireEvent.change(screen.getByLabelText('计费方式'),{target:{value:'per_second'}});
 fireEvent.click(screen.getByLabelText(/参考视频计费/));
 fireEvent.change(screen.getByLabelText('最多参考视频'),{target:{value:'2'}});
 fireEvent.submit(document.querySelector('#channel-model-form')!);
 await waitFor(()=>expect(api.save).toHaveBeenCalled());
 expect(api.save.mock.calls[0][1]).toMatchObject({snumom:{billingType:'per_second',referenceVideoBilling:true},limits:{maxVideos:2,resolutions:['720p','1080p']}});
 expect(api.save.mock.calls[0][1]).not.toHaveProperty('inputPrice');
});
