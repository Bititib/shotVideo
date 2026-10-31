import type { ModelInputLimits } from './modelRouting.js';
// Vx-魅影 only imports these selected public products. Keep the larger protocol
// catalog below for existing records and task recovery, not automatic discovery.
export const APIPATH_SYNC_MODEL_IDS = [
  'seedance2-5-特惠-1080p',
  'Seedance-2.0-mini-480-GK',
  'dola2.5',
  'gpt-image-2-5-sunburst-1k',
  'gpt-image-2-5-sunburst-2k',
  'gpt-image-2-5-sunburst-4k',
] as const;

// Provider snapshot 2026-10-31. Image count 1 is a local limit, not a provider maximum.
export const APIPATH_MODELS: {id: string; name: string; description?: string; kind: 'image' | 'video'; upstreamModel?: string; imageFamily?: string; limits: ModelInputLimits}[] = [
  {
    "id": "gpt-image-2-5-flare",
    "name": "GPT Image 2.5 Flare（渠道1）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-21",
    "name": "GPT Image 2（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "seedance-2.0-YZ",
    "name": "seedance-2.0-YZ",
    "kind": "video",
    "limits": {
      "maxImages": 9,
      "maxVideos": 3,
      "maxAudios": 3,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "480p",
        "720p",
        "1080p"
      ],
      "ratios": [
        "1:1",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "9:21",
        "16:9",
        "21:9"
      ],
      "qualities": [],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "seedance-2.0-Fast-YZ",
    "name": "seedance-2.0-Fast-YZ",
    "kind": "video",
    "limits": {
      "maxImages": 9,
      "maxVideos": 3,
      "maxAudios": 3,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "480p",
        "720p"
      ],
      "ratios": [
        "1:1",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "9:21",
        "16:9",
        "21:9"
      ],
      "qualities": [],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "seedance-2-0-mini",
    "name": "Seedance 2.0 Mini",
    "kind": "video",
    "limits": {
      "maxImages": 9,
      "maxVideos": 3,
      "maxAudios": 3,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "480p",
        "720p"
      ],
      "ratios": [
        "1:1",
        "3:4",
        "4:3",
        "4:5",
        "5:4",
        "9:16",
        "9:21",
        "16:9",
        "21:9"
      ],
      "qualities": [],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2",
    "name": "GPT Image 2（渠道1）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-sunburst",
    "name": "GPT Image 2.5 Sunburst（渠道1）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2（渠道2）",
    "name": "GPT Image 2（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-cdn（渠道2）",
    "name": "GPT Image 2 Cdn（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5（渠道2）",
    "name": "GPT Image 2.5（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-cdn（渠道2）",
    "name": "GPT Image 2.5 Cdn（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-flare（渠道2）",
    "name": "GPT Image 2.5 Flare（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-flare-cdn（渠道2）",
    "name": "GPT Image 2.5 Flare Cdn（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-sunburst（渠道2）",
    "name": "GPT Image 2.5 Sunburst（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-sunburst-cdn（渠道2）",
    "name": "GPT Image 2.5 Sunburst Cdn（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-4k（渠道2）",
    "name": "GPT Image 2 4k 超分（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-flare-4k（渠道2）",
    "name": "GPT Image 2.5 Flare 4K超分（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-sunburst-4k（渠道2）",
    "name": "GPT Image 2.5 Sunburst 4K超分（渠道2）",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-adobe",
    "name": "GPT Image 2 Adobe 全质量",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-flare-adobe",
    "name": "GPT Image 2.5 Flare Adobe 全质量",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "gpt-image-2-5-sunburst-adobe",
    "name": "GPT Image 2.5 Sunburst Adobe 全质量",
    "kind": "image",
    "limits": {
      "maxImages": 1,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "resolutions": [
        "default"
      ],
      "ratios": [
        "auto",
        "1:1",
        "2:3",
        "3:2",
        "3:4",
        "4:3",
        "9:16",
        "16:9"
      ],
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      }
    }
  },
  {
    "id": "seedance2-5-特惠-1080p",
    "name": "Seedance 2.5-1080P-福利特价",
    "description": "1080p；支持 5–30 秒（整数秒）；比例 9:16、16:9；最多 9 张参考图片、3 段参考音频；不支持参考视频及独立首尾帧。",
    "kind": "video",
    "limits": {
      "maxImages": 9,
      "maxVideos": 0,
      "maxAudios": 3,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "qualities": [],
      "duration": {
        "mode": "range",
        "min": 5,
        "max": 30,
        "step": 1,
        "values": []
      },
      "resolutions": [
        "1080p"
      ],
      "ratios": [
        "9:16",
        "16:9"
      ]
    }
  },
  {
    "id": "Seedance-2.0-mini-480-GK",
    "name": "Seedance-2.0-mini-480-GK",
    "description": "480p；支持 4–15 秒（整数秒）；比例 1:1、9:16、16:9；最多 9 张参考图片、3 个参考视频、3 段参考音频；不支持独立首尾帧。",
    "kind": "video",
    "limits": {
      "maxImages": 9,
      "maxVideos": 3,
      "maxAudios": 3,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "qualities": [],
      "duration": {
        "mode": "range",
        "min": 4,
        "max": 15,
        "step": 1,
        "values": []
      },
      "resolutions": [
        "480p"
      ],
      "ratios": [
        "1:1",
        "9:16",
        "16:9"
      ]
    }
  },
  {
    "id": "dola2.5",
    "name": "dola2.5",
    "description": "720p；仅支持 5、10、15 秒；比例 1:1、9:16、16:9；最多 9 张参考图片；不支持参考视频、参考音频及独立首尾帧。",
    "kind": "video",
    "limits": {
      "maxImages": 9,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "qualities": [],
      "duration": {
        "mode": "options",
        "min": 5,
        "max": 15,
        "step": 5,
        "values": [
          5,
          10,
          15
        ]
      },
      "resolutions": [
        "720p"
      ],
      "ratios": [
        "1:1",
        "9:16",
        "16:9"
      ]
    }
  },
  {
    "id": "gpt-image-2-5-sunburst-1k",
    "upstreamModel": "gpt-image-2-5-sunburst",
    "imageFamily": "gpt-image-2-5-sunburst",
    "name": "GPT Image 2.5 Sunburst（渠道1） 1K",
    "description": "1K 静态图片；支持文生图和参考图编辑；比例 1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9；最多 4 张参考图片，不支持参考视频或音频；每次输出 1 张。1:1 为 1024×1024，16:9 为 1280×720，其余比例按上游尺寸表输出。",
    "kind": "image",
    "limits": {
      "maxImages": 4,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 5,
        "max": 30,
        "step": 1,
        "values": []
      },
      "resolutions": [
        "1K"
      ],
      "ratios": [
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3",
        "21:9"
      ]
    }
  },
  {
    "id": "gpt-image-2-5-sunburst-2k",
    "upstreamModel": "gpt-image-2-5-sunburst",
    "imageFamily": "gpt-image-2-5-sunburst",
    "name": "GPT Image 2.5 Sunburst（渠道1） 2K",
    "description": "2K 静态图片；支持文生图和参考图编辑；比例 1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9；最多 4 张参考图片，不支持参考视频或音频；每次输出 1 张。1:1 为 2048×2048，16:9 为 2560×1440，其余比例按上游尺寸表输出。",
    "kind": "image",
    "limits": {
      "maxImages": 4,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 5,
        "max": 30,
        "step": 1,
        "values": []
      },
      "resolutions": [
        "2K"
      ],
      "ratios": [
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3",
        "21:9"
      ]
    }
  },
  {
    "id": "gpt-image-2-5-sunburst-4k",
    "upstreamModel": "gpt-image-2-5-sunburst",
    "imageFamily": "gpt-image-2-5-sunburst",
    "name": "GPT Image 2.5 Sunburst（渠道1） 4K",
    "description": "4K 静态图片；支持文生图和参考图编辑；比例 1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9；最多 4 张参考图片，不支持参考视频或音频；每次输出 1 张。4K 为上游档位名称：1:1 为 2880×2880，16:9 为 3840×2160，并非所有比例长边均为 4096；其余比例按上游尺寸表输出。",
    "kind": "image",
    "limits": {
      "maxImages": 4,
      "maxVideos": 0,
      "maxAudios": 0,
      "maxOutputs": 1,
      "minImages": 0,
      "firstFrame": false,
      "lastFrame": false,
      "qualities": [
        "auto",
        "low",
        "medium",
        "high"
      ],
      "duration": {
        "mode": "range",
        "min": 5,
        "max": 30,
        "step": 1,
        "values": []
      },
      "resolutions": [
        "4K"
      ],
      "ratios": [
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
        "3:2",
        "2:3",
        "21:9"
      ]
    }
  }
];
