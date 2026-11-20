import { apipathVideoUrl, pollApipathVideo, type ApipathChannel } from './apipathAdapter.js';
import { upstreamDiagnostic } from './upstreamDiagnostic.js';

async function downloadDiagnostic(c:ApipathChannel,stage:string,response:Response){
  let payload:unknown;
  try{
    const text=await response.text();
    try{payload=JSON.parse(text);}catch{
      // Object-storage XML contains private resource paths and signatures; expose only its diagnostic fields.
      const code=text.match(/<Code>([^<]*)<\/Code>/)?.[1],message=text.match(/<Message>([^<]*)<\/Message>/)?.[1];
      payload=code||message?{code,message}:text;
    }
  }catch{payload={message:'下载错误响应正文未能读取'};}
  return upstreamDiagnostic('通联',stage,payload,c.apiKey,response.status);
}

/** Read the original accepted job only. Storage URLs never receive platform credentials. */
export async function fetchApipathVideoContent(c: ApipathChannel, id: string, url: string): Promise<Response> {
  const contentUrl=apipathVideoUrl(c.baseUrl,id)+'/content';
  const direct=async (source:string) => {
    const parsed=new URL(source);
    if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('通联结果地址无效');
    return fetch(parsed.href,{headers:{},signal:AbortSignal.timeout(300_000)});
  };
  let response = url===contentUrl ? null : await direct(url);
  if(response?.ok)return response;
  // A stale completed receipt must not trap recovery on an expired signed URL.
  if(response && ![400,401,403,404,410].includes(response.status))throw new Error(await downloadDiagnostic(c,'成品直链下载',response));
  let queryError='';
  try {
    const task=await pollApipathVideo(c,id);
    if(task.status==='completed' && task.resultUrl && task.resultUrl!==url && task.resultUrl!==contentUrl){
      response=await direct(task.resultUrl);
      if(response.ok)return response;
    }
  } catch(error) { queryError=(error as Error).message; }
  // Documented read-only fallback; use the saved video Key on this exact API route only.
  response=await fetch(contentUrl,{headers:{Authorization:'Bearer '+c.apiKey},redirect:'manual',signal:AbortSignal.timeout(300_000)});
  if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');
    if(!location)throw new Error('通联原任务下载重定向缺少 Location');
    response=await direct(new URL(location,contentUrl).href);
  }
  if(!response.ok || response.status===202)throw new Error(await downloadDiagnostic(c,'原任务下载兜底'+(queryError?'；查询异常：'+queryError:''),response));
  return response;
}
