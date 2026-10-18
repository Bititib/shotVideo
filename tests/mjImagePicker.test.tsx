// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MjImagePicker, { latestMjImages } from '../client/src/canvas/MjImagePicker';
import { MJ_MODEL_ID } from '../shared/mj';
import { newNode, type CanvasVersion } from '../client/src/canvas/model';

afterEach(cleanup);
const versions = (requestId: string): CanvasVersion[] => [1,2,3,4].map(n => ({
  id: requestId + '-' + n, src: '/' + requestId + '-' + n + '.png', prompt: '纸船',
  model: MJ_MODEL_ID, ratio: '1:1', resolution: '1K', createdAt: n, requestId,
}));
const current = versions('current');
const node = { ...newNode('image', { x: 250, y: 340 }), model: MJ_MODEL_ID, src: current[0].src,
  versions: [...versions('previous'), ...current], job: { status: 'done' as const, requestId: 'current', expectedCount: 4, message: '已完成' } };

describe('floating MJ image choices', () => {
  it('shows only the four results from the latest task, retaining their original order', () => {
    expect(latestMjImages(node)).toEqual(current);
    expect(latestMjImages({ ...node, versions: [...versions('previous'), ...current.slice(0,2)] })).toEqual([]);
    expect(latestMjImages({ ...node, job: { ...node.job, status: 'running' } })).toEqual([]);
    expect(latestMjImages({ ...node, versions: current.map(v => ({ ...v, model: 'another-image-model' })) })).toEqual([]);
  });
  it('previews on hover and keyboard focus without selecting or starting a canvas drag', () => {
    const select = vi.fn(), drag = vi.fn();
    render(<div onPointerDown={drag}><MjImagePicker node={node} versions={current} view={{ x:0,y:0,zoom:1 }} viewport={{ width:1000,height:700 }} onSelect={select} /></div>);
    const second = screen.getByRole('button', { name: '将第 2 张图片设为当前版本' });
    fireEvent.pointerEnter(second);
    expect(screen.getByRole('img', { name: '第 2 张图片放大预览' }).getAttribute('src')).toBe(current[1].src);
    expect(select).not.toHaveBeenCalled();
    fireEvent.pointerLeave(second);
    expect(screen.queryByRole('img', { name: /放大预览/ })).toBeNull();
    fireEvent.pointerDown(second, { button: 0 }); expect(drag).not.toHaveBeenCalled();
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '将第 3 张图片设为当前版本' }));
    expect(screen.getByRole('img', { name: '第 3 张图片放大预览' })).toBeTruthy();
    fireEvent.click(document.activeElement!);
    expect(select).toHaveBeenCalledExactlyOnceWith(current[2]);
  });
  it('marks the current picture and preserves normal undo keyboard shortcuts', () => {
    const keyboard = vi.fn();
    render(<div onKeyDown={keyboard}><MjImagePicker node={{ ...node, src: current[2].src }} versions={current} view={{ x:0,y:0,zoom:1 }} viewport={{ width:360,height:640 }} onSelect={vi.fn()} /></div>);
    expect(screen.getByRole('button', { name: '将第 3 张图片设为当前版本' }).getAttribute('aria-pressed')).toBe('true');
    const first = screen.getByRole('button', { name: '将第 1 张图片设为当前版本' });
    fireEvent.keyDown(first, { key: 'z', ctrlKey: true }); expect(keyboard).toHaveBeenCalledOnce();
    fireEvent.keyDown(first, { key: 'ArrowRight' }); expect(keyboard).toHaveBeenCalledOnce();
  });
});
