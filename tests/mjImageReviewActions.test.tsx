// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../client/src/api/admin', () => ({ adminApi: { recoverMjImages: vi.fn() } }));
import { adminApi } from '../client/src/api/admin';
import { MjImageReviewActions } from '../client/src/components/MjImageReviewActions';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('MJ original result recovery', () => {
  it('requires matching-log confirmation and sends only the original download URL', async () => {
    vi.mocked(adminApi.recoverMjImages).mockResolvedValue({ status: 'completed', message: '四张图片已恢复' });
    const resolved = vi.fn(async () => {});
    render(<MjImageReviewActions id={13395} metadata={{ nativeImageOutputs: 4, requiresReview: true }} hasResult={false} onResolved={resolved} />);
    const button = screen.getByRole('button', { name: '取回原任务的四张图片' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://provider.example/v1/public/image/evt-original' } });
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    expect(adminApi.recoverMjImages).toHaveBeenCalledExactlyOnceWith(13395, ['https://provider.example/v1/public/image/evt-original']);
    expect(screen.getByRole('status').textContent).toBe('四张图片已恢复');
  });
  it('does not offer this action for completed or unrelated image tasks', () => {
    const { rerender } = render(<MjImageReviewActions id={1} metadata={{ nativeImageOutputs: 4 }} hasResult={false} onResolved={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<MjImageReviewActions id={1} metadata={{ nativeImageOutputs: 4, requiresReview: true }} hasResult onResolved={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(adminApi.recoverMjImages).not.toHaveBeenCalled();
  });
});
