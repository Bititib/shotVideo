import { describe, it, expect } from 'vitest';
import { newDocument, newNode, parseDocument } from '../client/src/canvas/model';
import { bindReferences, insertReference, resolveReferenceMentions } from '../client/src/canvas/referenceMentions';

const first = {...newNode('image',{x:0,y:0}),title:'同名图片',src:'/dog.png'};
const second = {...newNode('image',{x:0,y:0}),title:'同名图片',src:'/cat.png'};
const options = {kind:'image' as const};
describe('canvas reference identity',()=>{
  it('binds identical titles to distinct nodes and translates reordered input arrays',()=>{
    const bindings=bindReferences({},[first,second]);
    expect(resolveReferenceMentions('@图片1 的主体，@图片2 的背景',bindings,[second,first],options))
      .toEqual({prompt:'参考图片2 的主体，参考图片1 的背景',error:''});
    expect(bindReferences(bindings,[{...first,title:'改名'},second])).toEqual(bindings);
  });
  it('does not silently reassign disconnected references or reuse their labels',()=>{
    const bindings=bindReferences({},[first]);
    const next=bindReferences(bindings,[second]);
    expect(next['图片1']).toBe(first.id);
    expect(next['图片2']).toBe(second.id);
    expect(resolveReferenceMentions('@图片1',next,[second],options).error).toContain('已断开');
    expect(resolveReferenceMentions('@图片99',next,[second],options).error).toContain('不可用');
  });
  it('resolves frame roles and rejects unused frames',()=>{
    const bindings=bindReferences({},[first,second]);
    const mode={kind:'video' as const,videoMode:'frames' as const,firstFrameId:second.id};
    expect(resolveReferenceMentions('@图片2',bindings,[first,second],mode).prompt).toBe('首帧参考图片');
    expect(resolveReferenceMentions('@图片1',bindings,[first,second],mode).error).toContain('未设为');
  });
  it('inserts at the caret and retains following text',()=>{
    expect(insertReference('使用@猫 做背景',2,4,'图片2')).toEqual({prompt:'使用@图片2  做背景',caret:7});
  });
  it('preserves bindings through saved project reload and discards invalid binding keys',()=>{
    const doc=newDocument();
    doc.drafts={target:{kind:'image',prompt:'@图片1',model:'test',ratio:'1:1',resolution:'1K',seconds:5,
      referenceBindings:{'图片1':first.id,'invalid':second.id}}};
    expect(parseDocument(JSON.parse(JSON.stringify(doc))).drafts?.target.referenceBindings).toEqual({'图片1':first.id});
  });
});
