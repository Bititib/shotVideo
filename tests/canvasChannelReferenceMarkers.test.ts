import { describe, expect, it } from 'vitest';
import { bindReferences, resolveReferenceMentions } from '../client/src/canvas/referenceMentions';
import { newNode } from '../client/src/canvas/model';
import { buildMjNewApiVideoPayload, normalizeMjNewApiPrompt } from '../server/services/mjNewApiAdapter';
import { buildNewTokenVideoPayload } from '../server/services/newTokenAdapter';
import { buildSudaShuiVideoPayload, normalizeSudaShuiPrompt } from '../server/services/sudaShuiAdapter';
import { buildLongxiaVideoPayload, LONGXIA_MODELS } from '../server/services/longxiaVideoAdapter';
import { buildSiYueTianSeedance25VideoPayload } from '../server/services/siYueTianVideoModels';

describe('canvas references through channel payload construction', () => {
  const original = (['image','video','audio'] as const).flatMap(kind => [1,2].map(n => ({...newNode(kind,{x:0,y:0}),id:kind+n,src:`https://example.test/${kind}${n}`})));
  const reordered = [...original].reverse();
  const bindings = bindReferences({}, original);
  const resolved = resolveReferenceMentions('@图片1 @图片2 @视频1 @视频2 @音频1 @音频2',bindings,reordered,{kind:'video',videoMode:'multimodal'});
  const images = reordered.filter(n=>n.kind==='image').map(n=>n.src);
  const videos = reordered.filter(n=>n.kind==='video').map(n=>n.src);
  const audios = reordered.filter(n=>n.kind==='audio').map(n=>n.src);
  it.each(['mj','newtoken','suda','siyuetian'])('preserves reordered assets and native marker case for %s', channel => {
    const common={prompt:resolved.prompt,duration:5,aspectRatio:'16:9',resolution:'720p'};
    const payload = channel==='mj' ? buildMjNewApiVideoPayload({...common,model:'ad-seedance-2.5-480p',images,videos,audios})
      : channel==='newtoken' ? buildNewTokenVideoPayload({...common,model:'nd-seedance-2.0-720p',images,videos,audios})
      : channel==='suda' ? buildSudaShuiVideoPayload({...common,model:'sdas-bl-sd2.0-933-pro-720p',imageUrls:images,videoUrls:videos,audioUrls:audios})
      : buildSiYueTianSeedance25VideoPayload({...common,model:'seedance-2.0-fast-c2',seconds:5,imageUrls:images,videoUrls:videos,audioUrls:audios});
    const expected='@Image2 @Image1 @Video2 @Video1 @Audio2 @Audio1';
    expect(payload.prompt).toBe(channel==='suda'?expected.toLowerCase():expected);
    // The serializer must retain both references, in the resolved order, for each kind.
    const serialized=JSON.stringify(payload);
    for(const list of [images,videos,audios]) expect(serialized.indexOf(list[0])).toBeLessThan(serialized.indexOf(list[1]));
  });
  it('keeps LongXia lower-case markers aligned without appending duplicate references', () => {
    const nodes=reordered.filter(n=>n.kind!=='video');
    const prompt=resolveReferenceMentions('@图片1 @图片2 @音频1 @音频2',bindings,nodes,{kind:'video',videoMode:'multimodal'}).prompt;
    const payload=buildLongxiaVideoPayload({model:LONGXIA_MODELS[0],prompt,seconds:5,ratio:'16:9',resolution:'480p',imageUrls:images,audioUrls:audios});
    expect(payload.prompt).toBe('@image2 @image1 @audio2 @audio1');
    expect(payload.assets?.map(a=>a.url)).toEqual([...images,...audios]);
    expect(()=>buildLongxiaVideoPayload({model:LONGXIA_MODELS[0],prompt:'参考视频1',seconds:5,ratio:'16:9',resolution:'480p',videoUrls:videos})).toThrow('不支持视频参考');
  });
  it.each([normalizeMjNewApiPrompt,normalizeSudaShuiPrompt])('does not shift canvas numbering or reinterpret old image indexes', normalize => {
    const output=normalize('参考图片1 参考图片10 参考视频2 参考音频3 [ref_0.jpg] [ref_9.jpg] 参考音频0').toLowerCase();
    expect(output).toBe('@image1 @image10 @video2 @audio3 @image1 @image10 参考音频0');
  });
});
