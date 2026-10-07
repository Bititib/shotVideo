import React, { useEffect, useState } from 'react';
import { currentVideoModelStatus, VIDEO_MODEL_STATUS_DETAILS, VIDEO_MODEL_STATUS_LABELS, type VideoModelStatus } from '../../../shared/videoModelStatus';

const appearance = {
  healthy: { bars: 3, color: 'bg-emerald-500' },
  degraded: { bars: 2, color: 'bg-amber-500' },
  unavailable: { bars: 1, color: 'bg-red-500' },
  unknown: { bars: 0, color: 'bg-zinc-400' },
};

export default function VideoModelStatusIndicator({ status }: { status?: VideoModelStatus }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const currentTime = Date.now();
    setNow(currentTime);
    const expiresAt = Date.parse(status?.checkedAt || '') + 120_001;
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(expiresAt - currentTime, 180_001));
    return () => window.clearTimeout(timer);
  }, [status?.checkedAt]);
  const current = currentVideoModelStatus(status, now);
  const label = VIDEO_MODEL_STATUS_LABELS[current.state];
  const description = `${VIDEO_MODEL_STATUS_DETAILS[current.reason]}。依据最近24小时提交的最多20条已结束任务，非实时连通性检测。`;
  const { bars, color } = appearance[current.state];
  return (
    <span role="img" aria-label={`模型状态：${label}。${description}`}
      data-model-state={current.state} className="inline-flex shrink-0 items-center py-0.5">
      <span aria-hidden="true" className="inline-flex h-3 items-end gap-0.5">
        {['h-1.5', 'h-2', 'h-3'].map((height, index) => (
          <span key={height} className={`w-[3px] rounded-full ${height} ${index < bars ? color : 'bg-zinc-400/30'}`} />
        ))}
      </span>
    </span>
  );
}
