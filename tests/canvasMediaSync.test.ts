import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api/client';
import { mergeUploadedMedia, saveCloudWorkspace } from '../client/src/canvas/sync';
import { newDocument, newNode, type Workspace } from '../client/src/canvas/model';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
const sample=()=>{
  const document=newDocument();const src='data:image/png;base64,YWJj';
  document.nodes=[{...newNode('image',{x:0,y:0}),src,versions:[{id:'version',src,prompt:'',createdAt:0}]}];
  return {version:2,activeId:document.id,projects:[document],cloudRevision:3} as Workspace;
};
describe('durable media cloud sync',()=>{
  it('stops remaining uploads and workspace writes if the login session changes during an upload',async()=>{
    let token='original-session';
    vi.stubGlobal('localStorage',{getItem:()=>token});
    const post=vi.spyOn(api,'post').mockImplementationOnce(async()=>{token='different-session';return {url:'/api/media/first'};});
    const put=vi.spyOn(api,'put');
    const workspace=sample();workspace.projects[0].nodes.push({...newNode('image',{x:1,y:1}),src:'data:image/png;base64,bmV3'});
    await expect(saveCloudWorkspace(workspace)).rejects.toThrow('登录状态已变化');
    expect(post).toHaveBeenCalledTimes(1);expect(put).not.toHaveBeenCalled();
    expect(workspace.projects[0].nodes[0].src).toMatch(/^data:/);
  });
  it('stops the upload chain after cancellation even if an upload mock returns late',async()=>{
    const controller=new AbortController();
    const post=vi.spyOn(api,'post').mockImplementationOnce(async()=>{controller.abort();return {url:'/api/media/first'};});
    const put=vi.spyOn(api,'put');
    await expect(saveCloudWorkspace(sample(),controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(post).toHaveBeenCalledTimes(1);expect(put).not.toHaveBeenCalled();
  });
  it('merges only uploaded bytes and preserves newer replacements, deleted nodes, drafts and layouts',()=>{
    const sent=sample(), migrated=structuredClone(sent);
    migrated.projects[0].nodes[0].src='/api/media/old-result';
    migrated.projects[0].nodes[0].versions![0].src='/api/media/old-result';
    const current=structuredClone(sent);
    current.projects[0].nodes[0].src='data:image/png;base64,bmV3';
    current.projects[0].nodes[0].x=321;
    current.projects[0].title='最新标题';
    const merged=mergeUploadedMedia(current,sent,migrated);
    expect(merged.projects[0].nodes[0]).toMatchObject({src:'data:image/png;base64,bmV3',x:321,versions:[{src:'/api/media/old-result'}]});
    expect(merged.projects[0].title).toBe('最新标题');
    expect(current.projects[0].nodes[0].versions![0].src).toMatch(/^data:/);
    const deleted={...current,projects:[{...current.projects[0],nodes:[]}]};
    expect(mergeUploadedMedia(deleted,sent,migrated)).toBe(deleted);
    expect(mergeUploadedMedia(current,sent,undefined)).toBe(current);
  });
  it('uploads reused bytes once and persists stable media references without mutating local fallback',async()=>{
    const post=vi.spyOn(api,'post').mockResolvedValue({url:'/api/media/example'});
    const put=vi.spyOn(api,'put').mockResolvedValue({revision:4});
    const original=sample();const saved=await saveCloudWorkspace(original);
    expect(post).toHaveBeenCalledTimes(1);
    expect(saved.workspace.projects[0].nodes[0].src).toBe('/api/media/example');
    expect(saved.workspace.projects[0].nodes[0].versions![0].src).toBe('/api/media/example');
    expect(original.projects[0].nodes[0].src).toMatch(/^data:/);
    expect(put).toHaveBeenCalledWith('/canvas/workspace',{revision:3,workspace:saved.workspace});
  });
  it('keeps original data and does not save an incomplete cloud document if upload fails',async()=>{
    vi.spyOn(api,'post').mockRejectedValue(new Error('空间已满'));
    const put=vi.spyOn(api,'put');const original=sample();
    await expect(saveCloudWorkspace(original)).rejects.toThrow('空间已满');
    expect(put).not.toHaveBeenCalled();expect(original.projects[0].nodes[0].src).toMatch(/^data:/);
  });
});
