// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ModelRoutingPage from '../client/src/pages/admin/ModelRoutingPage';
import { adminApi } from '../client/src/api/admin';
import { defaultRoutingLimits } from '../shared/modelRouting';
vi.mock('../client/src/api/admin', () => ({ adminApi: { getPricing: vi.fn(), getModelSpecifications: vi.fn(), getModels: vi.fn(), getChannels: vi.fn(), getModelSpecificationSuggestions: vi.fn(), saveModelSpecification: vi.fn(), simulateModelRoutes: vi.fn(), resetModelRouteHealth: vi.fn() } }));
const limits = { ...defaultRoutingLimits(),maxImages:9 };
const spec = { modelId:'seedance-spec-900',displayName:'Seedance 2.5 · 900',kind:'video',enabled:true,aliases:[],limits,routes:[{ id:'r-1',channelId:1,executionModel:'seedance-a',upstreamModel:'upstream-a',enabled:true,limits,cost:1,costUnit:'per_call',resolutionCosts:{},priority:0 }],availableRouteCount:1,routeStatus:[] };
const models = [{ id:1,modelId:spec.modelId,displayName:spec.displayName,capabilities:['video'],isActive:1 },{ id:2,modelId:'seedance-a',displayName:'旧渠道入口',capabilities:['video'],isActive:1 }];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminApi.getPricing).mockResolvedValue(models.map(m => ({ modelPattern:m.modelId, configured:true, inherited:false, billingType:'per_call', inputPrice:2, extraParams:{} })));
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([structuredClone(spec)]);
  vi.mocked(adminApi.getModels).mockResolvedValue(models);
  vi.mocked(adminApi.getChannels).mockResolvedValue([{ id:1,name:'渠道 A',status:1,supportedModels:['seedance-a'],modelMapping:{} }]);
  vi.mocked(adminApi.getModelSpecificationSuggestions).mockResolvedValue([]);
  vi.mocked(adminApi.saveModelSpecification).mockResolvedValue({});
  vi.mocked(adminApi.simulateModelRoutes).mockResolvedValue({ selectedRouteId:'r-1',items:[{routeId:'r-1',channelId:1,reasons:[],estimatedCost:1}] });
});
afterEach(cleanup);
const mount = () => render(React.createElement(MemoryRouter,null,React.createElement(ModelRoutingPage)));
describe('model specification administrator workflow', () => {
  it('shows the channels for each specification and saves independent switches without renaming its API ID', async () => {
    mount(); fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    fireEvent.click(screen.getByRole('tab',{name:'规格设置'}));
    expect((screen.getByLabelText('API 模型 ID（保存后保持稳定）') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('用户看到的名称'),{target:{value:'新规格名称'}});
    fireEvent.click(screen.getByRole('tab',{name:/关联线路/}));
    fireEvent.click(screen.getByLabelText('启用这条模型线路'));
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    await waitFor(() => expect(adminApi.saveModelSpecification).toHaveBeenCalledWith(expect.objectContaining({ modelId:spec.modelId,displayName:'新规格名称',routes:[expect.objectContaining({ enabled:false })] })));
  });
  it('simulates counts, arbitrary duration and dedicated frames without calling generation', async () => {
    mount();fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    fireEvent.click(screen.getByRole('tab',{name:'模拟选路'}));
    const simulator = screen.getByRole('region',{name:'模拟选路'});
    fireEvent.change(within(simulator).getByLabelText('图片数'),{target:{value:'8'}});
    fireEvent.change(within(simulator).getByLabelText('秒数'),{target:{value:'15'}});
    fireEvent.click(within(simulator).getByLabelText('独立首帧'));
    fireEvent.click(within(simulator).getByRole('button',{name:'模拟',exact:true}));
    await waitFor(() => expect(adminApi.simulateModelRoutes).toHaveBeenCalledWith(spec.modelId,expect.objectContaining({reference_images:Array(8).fill('https://simulation.invalid/image.jpg'),video_length:15,first_frame:'https://simulation.invalid/first.jpg'})));
    expect(await screen.findByText(/优先选择/)).toBeTruthy();
    expect(adminApi.saveModelSpecification).not.toHaveBeenCalled();
  });
  it('loads existing integration drafts without applying them automatically', async () => {
    vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([]);
    vi.mocked(adminApi.getModelSpecificationSuggestions).mockResolvedValue([{...spec,aliases:['seedance-a']}]);
    mount();fireEvent.click(await screen.findByRole('button',{name:/添加规格/}));
    expect(screen.getByLabelText('用户看到的名称')).toBeTruthy();
    expect(screen.getByText(/合并已有重复入口（1 个）/)).toBeTruthy();
    expect(adminApi.saveModelSpecification).not.toHaveBeenCalled();
  });
});

const imageLimits = {...defaultRoutingLimits(),maxImages:16,maxOutputs:4,resolutions:['1K'],ratios:['1:1']};
const imageDraft = {modelId:'gpt-image-2-1k',imageFamily:'gpt-image-2',displayName:'GPT Image 2 · 1K',kind:'image',enabled:true,aliases:['gpt-image-2'],limits:imageLimits,routes:[]};
describe('image resolution administrator workflow', () => {
  it('saves a resolution entry and keeps reference capacity independent from its name', async () => {
    vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([]);
    vi.mocked(adminApi.getModels).mockResolvedValue([{id:3,modelId:'gpt-image-2',displayName:'GPT Image 2',capabilities:['image'],isActive:1}]);
    vi.mocked(adminApi.getModelSpecificationSuggestions).mockResolvedValue([structuredClone(imageDraft)]);
    mount(); fireEvent.click(await screen.findByRole('button',{name:/添加规格/}));
    fireEvent.change(screen.getByLabelText('输出分辨率（此入口固定）'),{target:{value:'2K'}});
    expect((screen.getByLabelText('API 模型 ID（保存后保持稳定）') as HTMLInputElement).value).toBe('gpt-image-2-2k');
    expect((screen.getByLabelText('用户看到的名称') as HTMLInputElement).value).toBe('GPT Image 2 · 2K');
    fireEvent.change(screen.getByLabelText('最多图片'),{target:{value:'10'}});
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    await waitFor(()=>expect(adminApi.saveModelSpecification).toHaveBeenCalledWith(expect.objectContaining({modelId:'gpt-image-2-2k',imageFamily:'gpt-image-2',displayName:'GPT Image 2 · 2K',limits:expect.objectContaining({maxImages:10,resolutions:['2K']})})));
  });
  it('allows another resolution to reuse the same legacy model alias', async () => {
    vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([{...imageDraft,availableRouteCount:0,routeStatus:[]}]);
    vi.mocked(adminApi.getModels).mockResolvedValue([{id:3,modelId:'gpt-image-2',displayName:'GPT Image 2',capabilities:['image'],isActive:1}]);
    vi.mocked(adminApi.getModelSpecificationSuggestions).mockResolvedValue([{...imageDraft,modelId:'gpt-image-2-2k',displayName:'GPT Image 2 · 2K',limits:{...imageLimits,resolutions:['2K']}}]);
    mount(); fireEvent.click(await screen.findByRole('button',{name:/添加规格/}));
    const alias=screen.getByRole('checkbox',{name:'GPT Image 2 · gpt-image-2',hidden:true}) as HTMLInputElement;
    expect(alias.checked).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    await waitFor(()=>expect(adminApi.saveModelSpecification).toHaveBeenCalledWith(expect.objectContaining({modelId:'gpt-image-2-2k',aliases:['gpt-image-2']})));
  });
  it('locks the saved output resolution and model family while retaining editable reference limits', async () => {
    vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([{...imageDraft,availableRouteCount:0,routeStatus:[]}]);
    mount(); fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    fireEvent.click(screen.getByRole('tab',{name:'规格设置'}));
    expect((screen.getByLabelText('输出分辨率（此入口固定）') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(/所属图片模型/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('最多图片') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('focused routing workspace',()=>{
  it('opens routes in a dedicated workspace and preserves edits across tabs',async()=>{
    mount();fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    expect(screen.queryByRole('region',{name:'规格列表'})).toBeNull();
    expect(screen.getByRole('tab',{name:/关联线路/}).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByLabelText('基础上游成本（元，未知留空）')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'配置线路'}));
    fireEvent.change(screen.getByLabelText('基础上游成本（元，未知留空）'),{target:{value:'0.35'}});
    fireEvent.click(screen.getByRole('tab',{name:'规格设置'}));
    fireEvent.change(screen.getByLabelText('用户看到的名称'),{target:{value:'新的公开名称'}});
    fireEvent.click(screen.getByRole('tab',{name:/关联线路/}));
    expect((screen.getByLabelText('基础上游成本（元，未知留空）') as HTMLInputElement).value).toBe('0.35');
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    await waitFor(()=>expect(adminApi.saveModelSpecification).toHaveBeenCalledWith(expect.objectContaining({displayName:'新的公开名称',routes:[expect.objectContaining({cost:.35})]})));
    expect(await screen.findByText('当前配置已保存')).toBeTruthy();
  });
  it('filters specifications by type, channel and availability',async()=>{
    vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([spec,{...imageDraft,availableRouteCount:0,routeStatus:[]}]);
    mount();await screen.findByText(imageDraft.displayName);
    fireEvent.click(screen.getByRole('button',{name:/图片\s*1/}));
    expect(screen.queryByText(spec.displayName)).toBeNull();
    fireEvent.change(screen.getByLabelText('按规格状态筛选'),{target:{value:'available'}});
    expect(screen.getByText('没有匹配的规格')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'清除筛选'}));
    fireEvent.change(screen.getByLabelText('按关联渠道筛选'),{target:{value:'1'}});
    expect(screen.queryByText(imageDraft.displayName)).toBeNull();
    expect(screen.getByText(spec.displayName)).toBeTruthy();
  });
  it('protects unsaved changes when returning to the catalog',async()=>{
    mount();fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    fireEvent.click(screen.getByLabelText('启用这条模型线路'));
    fireEvent.click(screen.getByRole('button',{name:'返回规格列表'}));
    expect(screen.getByRole('alert').textContent).toContain('有未保存的更改');
    fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('启用这条模型线路') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'返回规格列表'}));
    fireEvent.click(screen.getByRole('button',{name:'放弃更改并返回'}));
    expect(screen.getByRole('region',{name:'规格列表'})).toBeTruthy();
    expect(adminApi.saveModelSpecification).not.toHaveBeenCalled();
  });
  it('retains edits after a failed save and allows retry',async()=>{
    vi.mocked(adminApi.saveModelSpecification).mockRejectedValueOnce(new Error('保存失败，请重试'));
    mount();fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    fireEvent.click(screen.getByLabelText('启用这条模型线路'));
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','保存失败，请重试');
    expect(screen.getByText('有未保存的更改')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    expect(await screen.findByText('当前配置已保存')).toBeTruthy();
  });
  it('supports keyboard navigation between tabs without losing route edits',async()=>{
    mount();fireEvent.click(await screen.findByRole('button',{name:'管理线路'}));
    const routes=screen.getByRole('tab',{name:/关联线路/});routes.focus();
    fireEvent.keyDown(routes,{key:'ArrowRight'});
    expect(screen.getByRole('tab',{name:'规格设置'}).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab',{name:'规格设置'}));
    fireEvent.keyDown(document.activeElement!,{key:'End'});
    expect(screen.getByRole('region',{name:'模拟选路'})).toBeTruthy();
  });
});

describe('sale prices and upstream cost configuration', () => {
  it('shows the customer sale price separately from upstream costs and links its exact API ID', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', {name:'管理线路'}));
    expect(screen.getByRole('region', {name:'用户售价'}).textContent).toContain('720p ¥2/ 条');
    expect(screen.getByRole('link', {name:'管理用户售价'}).getAttribute('href')).toContain('priceModel=seedance-spec-900');
    fireEvent.click(screen.getByRole('button', {name:'配置线路'}));
    fireEvent.change(screen.getByLabelText('基础上游成本（元，未知留空）'), {target:{value:'0.01'}});
    expect(screen.getByRole('region', {name:'用户售价'}).textContent).toContain('720p ¥2/ 条');
  });
  it('requires an explicit upstream unit before entering costs on a new video route', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', {name:'管理线路'}));
    fireEvent.click(screen.getByRole('button', {name:'关联渠道'}));
    const unit=screen.getByLabelText('上游成本单位') as HTMLSelectElement;
    expect(unit.value).toBe('unknown');
    expect((screen.getByLabelText('基础上游成本（元，未知留空）') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(unit, {target:{value:'per_second'}});
    fireEvent.change(screen.getByLabelText('基础上游成本（元，未知留空）'), {target:{value:'0.05'}});
    fireEvent.click(screen.getByRole('button', {name:'保存规格与线路'}));
    await waitFor(()=>expect(adminApi.saveModelSpecification).toHaveBeenCalledWith(expect.objectContaining({routes:expect.arrayContaining([expect.objectContaining({costUnit:'per_second',cost:.05})])})));
  });
  it('blocks a differently billed alias and allows an incompatible saved alias to be removed', async () => {
    vi.mocked(adminApi.getPricing).mockResolvedValue([
      {modelPattern:spec.modelId,configured:true,billingType:'per_call',inputPrice:2,extraParams:{}},
      {modelPattern:'seedance-a',configured:true,billingType:'per_second',inputPrice:.1,extraParams:{}}
    ]);
    mount(); fireEvent.click(await screen.findByRole('button', {name:'管理线路'}));
    fireEvent.click(screen.getByRole('tab',{name:'规格设置'}));
    const checkbox=screen.getByRole('checkbox',{name:/旧渠道入口/,hidden:true}) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText('用户计费单位不同，保留独立入口')).toBeTruthy();
    cleanup();
    vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([{...spec,aliases:['seedance-a']}]);
    mount(); fireEvent.click(await screen.findByRole('button', {name:'管理线路'}));
    expect(screen.getByRole('alert').textContent).toContain('旧入口合并需要核对');
    fireEvent.click(screen.getByRole('tab',{name:'规格设置'}));
    fireEvent.click(screen.getByRole('checkbox',{name:/旧渠道入口/,hidden:true}));
    fireEvent.click(screen.getByRole('button',{name:'保存规格与线路'}));
    await waitFor(()=>expect(adminApi.saveModelSpecification).toHaveBeenCalledWith(expect.objectContaining({aliases:[]})));
  });
});
