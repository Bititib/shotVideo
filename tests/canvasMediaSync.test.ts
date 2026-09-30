import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api/client';
import { saveCloudWorkspace } from '../client/src/canvas/sync';
import { newDocument, newNode, type Workspace } from '../client/src/canvas/model';
afterEach(()=>vi.restoreAllMocks());
const sample=()=>{
  const document=newDocument();const src='data:image/png;base64,YWJj';
  document.nodes=[{...newNode('image',{x:0,y:0}),src,versions:[{id:'version',src,prompt:'',createdAt:0}]}];
  return {version:2,activeId:document.id,projects:[document],cloudRevision:3} as Workspace;
};
describe('durable media cloud sync',()=>{
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
