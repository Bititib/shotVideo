import { HUSS_BB_PUBLIC_MODEL, HUSS_HSS_MODEL } from './hussBbVideo.js';
import { defaultRoutingLimits } from './modelRouting.js';
export const BB_HSS_KK_ENTRIES = [HUSS_BB_PUBLIC_MODEL,HUSS_HSS_MODEL] as const;
export const isBbHssKkEntry = (id: string) => (BB_HSS_KK_ENTRIES as readonly string[]).includes(id);
export const bbHssKkLimits = () => ({...defaultRoutingLimits(),maxImages:30,maxVideos:10,maxAudios:10,
  resolutions:['720p'],duration:{mode:'range' as const,min:5,max:30,step:1,values:[]}});
