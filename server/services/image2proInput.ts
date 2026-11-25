/** Normalize only Image2Pro's documented aliases before shared routing and billing. */
export function normalizeImage2proInput(body: Record<string, any>, kind: 'image' | 'video') {
  delete body.image2proVideoOptions;
  for (const keys of [['aspect_ratio','ratio'],['resolution','output_resolution','image_size'],['video_length','duration','seconds']]) {
    const supplied=keys.filter(k=>body[k]!==undefined && body[k]!=='');
    if(new Set(supplied.map(k=>String(body[k]).toLowerCase())).size>1)throw new Error('Image2Pro 参数不一致：'+supplied.join(' / '));
    if(supplied.length)body[keys[0]]=body[supplied[0]];
  }
  for(const keys of [['reference_images','image_urls','image_url','images','input_image','reference_image','image'],['reference_videos','reference_video','video_urls','video_url','videos'],['audio_urls','audio_url','reference_audios','audios']]) {
    const supplied=keys.filter(k=>body[k]!==undefined&&body[k]!==''&&(!Array.isArray(body[k])||body[k].length));
    if(supplied.length>1)throw new Error('Image2Pro 请只使用一个素材字段：'+supplied.join(' / '));
    if(!supplied.length)continue;
    let value=body[supplied[0]];
    if(typeof value==='string'&&value.trim().startsWith('['))value=JSON.parse(value);
    if(!Array.isArray(value))value=[value];
    if(keys[0]==='reference_images' && value.some((v:any)=>v && typeof v==='object')) {
      const refs=value.map((v:any)=>typeof v==='string'?{url:v}:v);
      if(!refs.every((v:any)=>v&&typeof v.url==='string'&&Object.keys(v).every(k=>['url','role'].includes(k))))throw new Error('Image2Pro 图片对象仅支持 url 和 role');
      const frames=refs.filter((v:any)=>v.role);
      if(frames.length){
        if(frames.length!==refs.length)throw new Error('Image2Pro 首尾帧不能与普通参考图混用');
        for(const ref of frames){if(!['first_frame','last_frame'].includes(ref.role)||body[ref.role])throw new Error('Image2Pro 首尾帧重复或角色无效');body[ref.role]=ref.url;}
        value=[];
      } else value=refs.map((v:any)=>v.url);
    }
    if(keys[0]==='reference_videos') {
      body.image2proVideoOptions=value.map((v:any)=>{
        if(typeof v==='string')return {};
        if(!v||typeof v.url!=='string'||Object.keys(v).some(k=>!['url','start_seconds','require_audio'].includes(k))||v.start_seconds!==undefined&&(!Number.isFinite(v.start_seconds)||v.start_seconds<0)||v.require_audio!==undefined&&typeof v.require_audio!=='boolean')throw new Error('Image2Pro 视频对象须为 url、非负 start_seconds 和布尔 require_audio');
        return {...(v.start_seconds!==undefined?{start_seconds:v.start_seconds}:{}),...(v.require_audio!==undefined?{require_audio:v.require_audio}:{})};
      });
      value=value.map((v:any)=>typeof v==='string'?v:v.url);
    }
    if(!value.every((v:any)=>typeof v==='string'&&v.trim()))throw new Error('Image2Pro 当前网站入口的参考素材必须为 URL 或 Data URL 字符串；请勿传入素材对象');
    for(const key of keys)delete body[key];
    body[keys[0]]=value;
  }
  if(body.size && body.size!=='auto') {
    const match=/^([1-9]\d{1,4})x([1-9]\d{1,4})$/i.exec(body.size);
    if(!match)throw new Error('Image2Pro size 须为宽x高，例如 1024x1024');
    if (kind === 'image' && match[1] === match[2]) {
      const squareTiers: Record<string, string> = { '1024': '1K', '2048': '2K', '4096': '4K' };
      const tier = squareTiers[match[1]];
      if (tier) {
        if (body.resolution && String(body.resolution).toLowerCase() !== 'auto' && String(body.resolution).toUpperCase() !== tier) {
          throw new Error('Image2Pro size 与 resolution 不一致：' + body.size + ' 对应 ' + tier);
        }
        body.resolution = tier;
        if (body.output_resolution !== undefined) body.output_resolution = tier;
      }
    }
    if(!body.aspect_ratio){const w=Number(match[1]),h=Number(match[2]);const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;const g=gcd(w,h);body.aspect_ratio=(w/g)+':'+(h/g);}
  }
}

export function image2proChatParameterError(body: Record<string,any>): string | undefined {
 for(const [field,min,max] of [['temperature',0,2],['top_p',0,1],['frequency_penalty',-2,2],['presence_penalty',-2,2]] as const){
  if(body[field]!==undefined&&(typeof body[field]!=='number'||!Number.isFinite(body[field])||body[field]<min||body[field]>max))return 'Image2Pro '+field+' 必须为 '+min+' 至 '+max+' 的数字';
 }
 if(body.seed!==undefined&&!Number.isSafeInteger(body.seed))return 'Image2Pro seed 必须为安全整数';
 if(body.stop!==undefined&&!(typeof body.stop==='string'||Array.isArray(body.stop)&&body.stop.length<=4&&body.stop.every((v:any)=>typeof v==='string')))return 'Image2Pro stop 须为字符串或最多四个字符串';
 if(body.response_format!==undefined&&(!body.response_format||!['text','json_object','json_schema'].includes(body.response_format.type)))return 'Image2Pro response_format.type 须为 text、json_object 或 json_schema';
 if(!Array.isArray(body.messages)||!body.messages.length)return 'Image2Pro messages 必须为非空消息数组';
}
