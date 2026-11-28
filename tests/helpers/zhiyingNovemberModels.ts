// Verbatim catalog rows from https://zhiyingai.org/api/openapi, 2026-11-28.
export const novemberZhiyingRows = [
  {
    "id": "minimax-h3-line1",
    "name": "Minimax H3-专线1",
    "display_name": "Minimax H3-专线1",
    "aliases": [
      "Minimax H3-专线1"
    ],
    "object": "model",
    "media_type": "video",
    "status": "available",
    "available": true,
    "create_endpoint": "/v1/generations",
    "status_endpoint": "/v1/generations/{task_id}",
    "resolutions": {
      "2k": {
        "durations": [
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28
        ]
      }
    },
    "default_resolution": "2k",
    "default_duration": 10,
    "default_aspect_ratio": "16:9",
    "aspect_ratios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9"
    ],
    "reference_limits": {
      "images": 9,
      "videos": 3,
      "audios": 3,
      "total": 12
    },
    "reference_file_max_bytes": {
      "image": 20971520,
      "video": 104857600,
      "audio": 31457280
    },
    "reference_input_types": [
      "file_id",
      "https_url"
    ],
    "reference_video_max_seconds": 15,
    "reference_video_total_max_seconds": 15,
    "prompt_max": 10000,
    "pricing": {
      "unit": "per_second",
      "points_per_second": 10,
      "bands": [
        {
          "resolution": "2k",
          "points": 10,
          "unit": "per_second"
        }
      ]
    },
    "cancel_supported": false
  },
  {
    "id": "fast-video-seedance25",
    "name": "速刷 Seedance 2.5",
    "display_name": "速刷 Seedance 2.5",
    "aliases": [
      "速刷 Seedance 2.5"
    ],
    "object": "model",
    "media_type": "video",
    "status": "available",
    "status_label": "已开放",
    "available": true,
    "billing_mode": "per_generation",
    "pricing": {
      "mode": "per_generation",
      "currency": "points",
      "unit": "per_generation",
      "bands": [
        {
          "resolution": "720p",
          "points": 398,
          "unit": "per_generation"
        }
      ]
    },
    "resolutions": {
      "720p": {
        "durations": [
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28,
          29,
          30
        ]
      }
    },
    "default_resolution": "720p",
    "default_duration": 30,
    "default_aspect_ratio": "16:9",
    "aspect_ratios": [
      "adaptive",
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9"
    ],
    "reference_limits": {
      "images": 30,
      "videos": 10,
      "audios": 10
    },
    "reference_file_max_bytes": {
      "image": 20971520,
      "video": 104857600,
      "audio": 15728640
    },
    "reference_input_types": [
      "file_id"
    ],
    "prompt_max": 10000,
    "create_endpoint": "/v1/generations",
    "status_endpoint": "/v1/generations/{task_id}",
    "cancel_supported": false
  },
  {
    "id": "fast-video-magi2",
    "name": "速刷 MAGI-2",
    "display_name": "速刷 MAGI-2",
    "aliases": [
      "速刷 MAGI-2"
    ],
    "object": "model",
    "media_type": "video",
    "status": "available",
    "status_label": "已开放",
    "available": true,
    "billing_mode": "per_generation",
    "pricing": {
      "mode": "per_generation",
      "currency": "points",
      "unit": "per_generation",
      "bands": [
        {
          "resolution": "1080p",
          "points": 298,
          "unit": "per_generation"
        }
      ]
    },
    "resolutions": {
      "1080p": {
        "durations": [
          4,
          5,
          6,
          7,
          8,
          9,
          10,
          11,
          12,
          13,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28,
          29,
          30
        ]
      }
    },
    "default_resolution": "1080p",
    "default_duration": 30,
    "default_aspect_ratio": "16:9",
    "aspect_ratios": [
      "adaptive",
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4"
    ],
    "reference_limits": {
      "images": 10,
      "videos": 5,
      "audios": 5
    },
    "reference_file_max_bytes": {
      "image": 20971520,
      "video": 104857600,
      "audio": 15728640
    },
    "reference_input_types": [
      "file_id"
    ],
    "prompt_max": 10000,
    "create_endpoint": "/v1/generations",
    "status_endpoint": "/v1/generations/{task_id}",
    "cancel_supported": false
  }
];
