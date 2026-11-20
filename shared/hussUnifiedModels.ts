// HUSS unified-capabilities.json, verified 2026-11-20. Account authorization remains separate.
import { defaultRoutingLimits, type ModelInputLimits } from './modelRouting.js';
export const hussUnifiedModels = [
  {
    "id": "db-seedance2.0-900",
    "duration": {
      "min": 5,
      "max": 15,
      "enum": [
        5,
        10,
        15
      ],
      "default": 5
    },
    "resolutions": [
      "default"
    ],
    "ratios": [
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16"
    ],
    "references": {
      "images": 10,
      "videos": 0,
      "audios": 0
    },
    "promptRequired": true
  },
  {
    "id": "ht-2.5-301010-渠道A",
    "duration": {
      "min": 5,
      "max": 30,
      "default": 10
    },
    "resolutions": [
      "480p",
      "720p",
      "1080p"
    ],
    "ratios": [
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16"
    ],
    "references": {
      "images": 30,
      "videos": 10,
      "audios": 10
    },
    "promptRequired": true
  },
  {
    "id": "bb-2.5-301010-渠道A",
    "duration": {
      "min": 5,
      "max": 30,
      "default": 5
    },
    "resolutions": [
      "720p"
    ],
    "ratios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9",
      "adaptive"
    ],
    "references": {
      "images": 30,
      "videos": 10,
      "audios": 10,
      "total": 30
    },
    "promptRequired": true
  },
  {
    "id": "mm-2.5-flash-105",
    "duration": {
      "min": 4,
      "max": 30,
      "default": 5
    },
    "resolutions": [
      "720p",
      "480p"
    ],
    "ratios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9"
    ],
    "references": {
      "images": 10,
      "videos": 0,
      "audios": 5,
      "total": 15
    },
    "promptRequired": true
  },
  {
    "id": "AM-2.5-301010",
    "duration": {
      "min": 5,
      "max": 30,
      "default": 10
    },
    "resolutions": [
      "480p",
      "720p"
    ],
    "ratios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9"
    ],
    "references": {
      "images": 30,
      "videos": 10,
      "audios": 10,
      "total": 50
    },
    "promptRequired": true
  },
  {
    "id": "GP-2.5-301010渠道A",
    "duration": {
      "min": 4,
      "max": 30,
      "default": 30
    },
    "resolutions": [
      "480p",
      "720p",
      "1080p",
      "4k"
    ],
    "ratios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9"
    ],
    "references": {
      "images": 30,
      "videos": 10,
      "audios": 10,
      "total": 50
    },
    "promptRequired": true
  },
  {
    "id": "AP-2.5-301010渠道A",
    "duration": {
      "min": 5,
      "max": 30,
      "default": 5
    },
    "resolutions": [
      "720p"
    ],
    "ratios": [
      "16:9",
      "9:16"
    ],
    "references": {
      "images": 30,
      "videos": 10,
      "audios": 10,
      "total": 50
    },
    "promptRequired": true
  }
] as const;
export function isHussUnifiedVideoModel(id: unknown): boolean { return hussUnifiedModels.some(m=>m.id===id); }
export function hussUnifiedVideoLimits(id: string): ModelInputLimits | undefined {
 const m=hussUnifiedModels.find(m=>m.id===id);if(!m)return;
 const values='enum' in m.duration ? [...m.duration.enum] : [];
 return {...defaultRoutingLimits(),maxImages:m.references.images,maxVideos:m.references.videos,maxAudios:m.references.audios,maxOutputs:1,minImages:0,
 ...('total' in m.references?{maxReferences:m.references.total}:{}),resolutions:[...m.resolutions],ratios:[...m.ratios],
 defaultSeconds:m.duration.default,duration:{mode:values.length?'options':'range',min:m.duration.min,max:m.duration.max,step:1,values}};
}
