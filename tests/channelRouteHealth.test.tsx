// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ChannelRouteHealth from '../client/src/components/ChannelRouteHealth';
import { adminApi } from '../client/src/api/admin';
vi.mock('../client/src/api/admin', () => ({ adminApi:{ getModelSpecifications:vi.fn(), resetModelRouteHealth:vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
const fixture = (state = 'cooldown') => [{ modelId:'mj-imagine-1k', displayName:'MJ', routes:[{ id:'mj-26', channelId:26 }], routeStatus:[{ id:'mj-26', health:[{ key:'26:0:mj_imagine', state, lastError:state === 'blocked' ? 'invalid API key sk-secret' : 'insufficient credits https://private.invalid', retryAt:Date.now() + 60_000 }] }] }];
it('restores only the selected channel and continues refreshing after restoration', async () => {
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue(fixture());
  vi.mocked(adminApi.resetModelRouteHealth).mockResolvedValue({});
  render(<ChannelRouteHealth channelId={26} />);
  await screen.findByText(/上游积分不足/);
  expect(screen.queryByText(/private.invalid/)).toBeNull();
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([]);
  fireEvent.click(screen.getByRole('button', { name:'立即恢复' }));
  await screen.findByText(/已解除线路暂停/);
  expect(adminApi.resetModelRouteHealth).toHaveBeenCalledExactlyOnceWith('mj-imagine-1k','26:0:mj_imagine');
  expect(screen.queryByRole('button', { name:'立即恢复' })).toBeNull();
});
it('shows credential guidance and reports failed restore without claiming success', async () => {
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue(fixture('blocked'));
  vi.mocked(adminApi.resetModelRouteHealth).mockRejectedValue(new Error('server error'));
  render(<ChannelRouteHealth channelId={26} />);
  await screen.findByText(/密钥或权限异常/);
  expect(screen.queryByText(/sk-secret/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name:'立即恢复' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/已解除线路暂停/)).toBeNull();
});
it('never offers restoration for another channel', async () => {
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue(fixture());
  render(<ChannelRouteHealth channelId={27} />);
  await screen.findByText('当前没有暂停的线路。');
  expect(screen.queryByRole('button', { name:'立即恢复' })).toBeNull();
});
it('keeps polling after a restore so a subsequent failure is visible', async () => {
  vi.useFakeTimers();
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue(fixture());
  vi.mocked(adminApi.resetModelRouteHealth).mockResolvedValue({});
  render(<ChannelRouteHealth channelId={26} />);
  await act(async () => {});
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([]);
  fireEvent.click(screen.getByRole('button', { name:'立即恢复' }));
  await act(async () => {});
  vi.mocked(adminApi.getModelSpecifications).mockResolvedValue(fixture());
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByRole('button', { name:'立即恢复' })).toBeEnabled();
});
