// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import VideoModelStatusIndicator from '../client/src/components/VideoModelStatusIndicator';
import type { VideoModelStatus } from '../shared/videoModelStatus';

afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('model status indicator', () => {
  it('expires a displayed status even when background refresh fails', () => {
    vi.useFakeTimers();
    render(<VideoModelStatusIndicator status={{ state: 'healthy', reason: 'recent_successes', checkedAt: new Date().toISOString() }} />);
    expect(screen.getByText('正常')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(120001));
    expect(screen.getByText('待检测')).toBeInTheDocument();
  });
  it.each([
    ['healthy', 'recent_successes', '正常'], ['degraded', 'recent_failures', '波动'],
    ['unavailable', 'consecutive_failures', '异常'], ['unknown', 'insufficient_data', '待检测'],
  ] as const)('shows accessible %s bars and no percentage', (state, reason, label) => {
    const { container } = render(<VideoModelStatusIndicator status={{ state, reason, checkedAt: new Date().toISOString() }} />);
    expect(screen.getByRole('img', { name: new RegExp(`模型状态：${label}`) })).toHaveAttribute('data-model-state', state);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/成功率|%/);
  });
  it('old model lists and stale statuses display unknown instead of the legacy baseline', () => {
    const { rerender } = render(<VideoModelStatusIndicator />);
    expect(screen.getByText('待检测')).toBeInTheDocument();
    const status: VideoModelStatus = { state: 'healthy', reason: 'recent_successes', checkedAt: '2020-01-01T00:00:00Z' };
    rerender(<VideoModelStatusIndicator status={status} />);
    expect(screen.getByText('待检测')).toBeInTheDocument();
  });
});
