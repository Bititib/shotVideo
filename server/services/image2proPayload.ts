// Shared by the administrator preview and the real video submission.
export function buildImage2proVideoPayload(model: any, request: {prompt:string; images:string[]; videos:string[]; audios:string[]; firstFrame:string; lastFrame:string; input:{seconds:number;ratio:string;resolution:string}}) {
    const md=model.metadata, standard=md.media_contract===1, flow=!standard&&typeof md.supports_frame_control==='boolean', legacy=!standard&&!flow;
    const durations=md.durations || (Number.isInteger(md.duration_min)&&Number.isInteger(md.duration_max)&&md.duration_max>=md.duration_min&&md.duration_max<=120?Array.from({length:md.duration_max-md.duration_min+1},(_,i)=>md.duration_min+i):[]);
    if(request.videos.length>(legacy?(md.max_video_references||0):0)||request.audios.length>(legacy?(md.max_audio_references||0):0))throw new Error('Image2Pro 视频或音频参考数量不符合模型能力');
    if((request.firstFrame||request.lastFrame)&&(request.videos.length||request.audios.length))throw new Error('Image2Pro 首尾帧不能与视频音频混用');
    if((request.firstFrame||request.lastFrame)&&(!(md.supports_frame_control||legacy&&md.modes?.includes('keyframe'))||flow&&!request.firstFrame||request.images.length))throw new Error('Image2Pro 首尾帧组合不支持：必须有首帧且不能混用普通参考图');
    if(flow && request.images.length && !md.supports_reference_images)throw new Error('Image2Pro 此型号不支持普通参考图');
    if(!durations.includes(request.input.seconds))throw new Error('Image2Pro 时长与模型能力不符');
    const payload:Record<string,unknown>={model:model.id,prompt:request.prompt,duration:request.input.seconds,images:request.images};
    if(request.images.length<(md.min_images||0)||request.images.length>(md.max_images??(md.supports_reference_images?3:0)))throw new Error('Image2Pro 参考图数量超出模型能力');
    for(const [key,value,allowed] of [['ratio',request.input.ratio,md.aspect_ratios],['resolution',request.input.resolution,md.resolutions]] as const) {
      if(Array.isArray(allowed)&&allowed.length){const selected=allowed.find((option:unknown)=>typeof option==='string'&&option.toLowerCase()===value.toLowerCase());if(!selected)throw new Error('Image2Pro '+key+' 不支持所选值');payload[key]=selected;}
    }
    if(flow){
      payload.reference_images=payload.images;delete payload.images;
      if(payload.ratio){payload.aspect_ratio=payload.ratio;delete payload.ratio;}
      if(request.firstFrame)payload.reference_images=[{url:request.firstFrame,role:'first_frame'},...(request.lastFrame?[{url:request.lastFrame,role:'last_frame'}]:[])];
    }
    if(legacy){
      if(md.size && request.input.resolution!=='auto' && request.input.resolution.toLowerCase()!==String(md.size).toLowerCase())throw new Error('Image2Pro 固定清晰度与所选规格不一致');
      if(md.size)payload.size=md.size;
      if(request.audios.length)payload.audios=request.audios;
      if(request.videos.length)payload.videos=request.videos.map(s=>({url:s}));
      if(request.firstFrame)payload.first_frame=request.firstFrame;
      if(request.lastFrame)payload.last_frame=request.lastFrame;
      if(Array.isArray(md.modes)){const mode=request.firstFrame||request.lastFrame?'keyframe':request.images.length||request.videos.length||request.audios.length?'reference':'text';if(!md.modes.includes(mode))throw new Error('Image2Pro 此模型不支持 '+mode);payload.mode=mode;}
    }
    return { payload, standard, legacy, md };
}
