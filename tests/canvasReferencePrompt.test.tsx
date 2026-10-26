// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ReferencePrompt from '../client/src/canvas/ReferencePrompt';
import { newDocument, newNode } from '../client/src/canvas/model';
import { resolveReferenceMentions } from '../client/src/canvas/referenceMentions';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const image = { ...newNode('image', { x: 0, y: 0 }), title: '角色图', src: '/actor.png' };
const video = { ...newNode('video', { x: 0, y: 0 }), title: '动作视频', src: '/action.mp4' };
const audio = { ...newNode('audio', { x: 0, y: 0 }), title: '背景音频', src: '/audio.wav' };
const props = { value: '', onChange: vi.fn(), placeholder: '提示词', references: [], bindings: {}, kind: 'video' as const, onPick: vi.fn() };
function mention() { fireEvent.change(screen.getByPlaceholderText('提示词'), { target: { value: '@', selectionStart: 1 } }); }

describe('canvas reference candidate selection', () => {
  it('keeps the mention list inside a short viewport when a tall prompt is clipped by its panel', () => {
    vi.stubGlobal('innerHeight', 360);
    render(<div style={{ overflowY: 'auto' }} data-testid="prompt-scroll"><ReferencePrompt {...props} document={{ ...newDocument(), nodes: [image] }} /></div>);
    vi.spyOn(screen.getByPlaceholderText('提示词'), 'getBoundingClientRect').mockReturnValue({ left: 40, right: 440, top: -160, bottom: 480, width: 400, height: 640 } as DOMRect);
    vi.spyOn(screen.getByTestId('prompt-scroll'), 'getBoundingClientRect').mockReturnValue({ left: 40, right: 440, top: 90, bottom: 270, width: 400, height: 180 } as DOMRect);
    mention();
    const menu = screen.getByRole('listbox').closest('.studio-mention-menu') as HTMLElement;
    const top = Number.parseFloat(menu.style.top);
    const height = Number.parseFloat(menu.style.maxHeight);
    expect(top).toBeGreaterThanOrEqual(12);
    expect(top + height).toBeLessThanOrEqual(348);
    expect(screen.getByRole('option', { name: /角色图/ })).toBeTruthy();
  });
  it('repositions the open menu when the composer scrolls, the prompt resizes or the viewport changes', () => {
    vi.stubGlobal('innerHeight', 800);
    let resize: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect = disconnect; });
    const view = render(<ReferencePrompt {...props} document={{ ...newDocument(), nodes: [image] }} />);
    const rect = vi.spyOn(screen.getByPlaceholderText('提示词'), 'getBoundingClientRect').mockReturnValue({ left: 40, right: 440, top: 500, bottom: 700, width: 400, height: 200 } as DOMRect);
    mention();
    const menu = screen.getByRole('listbox').closest('.studio-mention-menu') as HTMLElement;
    const firstTop = menu.style.top;
    rect.mockReturnValue({ left: 40, right: 440, top: 90, bottom: 200, width: 400, height: 110 } as DOMRect);
    fireEvent.scroll(screen.getByPlaceholderText('提示词'));
    expect(menu.style.top).not.toBe(firstTop);
    expect(menu.style.top).toBe('208px');
    rect.mockReturnValue({ left: 40, right: 440, top: 90, bottom: 250, width: 400, height: 160 } as DOMRect);
    act(() => resize?.([], {} as ResizeObserver));
    expect(menu.style.top).toBe('258px');
    vi.stubGlobal('innerHeight', 400);
    fireEvent(window, new Event('resize'));
    expect(Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(388);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it('finds unconnected image, video and audio inputs without switching scopes', () => {
    render(<ReferencePrompt {...props} document={{ ...newDocument(), nodes: [image, video, audio] }} />);
    mention();
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: /角色图/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /动作视频/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /背景音频/ })).toBeTruthy();
  });
  it('keeps image generation limited to compatible media and supports search by media kind', () => {
    render(<ReferencePrompt {...props} kind="image" document={{ ...newDocument(), nodes: [image, video, audio] }} />);
    fireEvent.change(screen.getByPlaceholderText('提示词'), { target: { value: '@图片', selectionStart: 3 } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /角色图/ })).toBeTruthy();
  });
  it('excludes the actual generator, unfinished media and links that would form a cycle', () => {
    const target = { ...newNode('video', { x: 0, y: 0 }), generator: true, src: '/previous.mp4' };
    const pending = { ...image, id: 'pending', job: { status: 'running' as const } };
    const document = { ...newDocument(), nodes: [target, image, video, pending], edges: [{ id: 'downstream', from: target.id, to: video.id }] };
    render(<ReferencePrompt {...props} document={document} target={target} />);
    mention();
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /角色图/ })).toBeTruthy();
  });
  it('does not insert while composing and keeps keyboard selection valid after candidates change', () => {
    const onPick = vi.fn(() => 5);
    const view = render(<ReferencePrompt {...props} onPick={onPick} document={{ ...newDocument(), nodes: [image, video, audio] }} />);
    mention();
    const input = screen.getByPlaceholderText('提示词');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    view.rerender(<ReferencePrompt {...props} onPick={onPick} document={{ ...newDocument(), nodes: [image] }} />);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: image.id }), 0, 1);
  });
  it('resolves previously saved full-width mentions to the submitted media order', () => {
    expect(resolveReferenceMentions('＠图片1 和 @视频1，配合＠音频1', { 图片1: image.id, 视频1: video.id, 音频1: audio.id }, [image, video, audio], { kind: 'video', videoMode: 'multimodal' }))
      .toEqual({ prompt: '参考图片1 和 参考视频1，配合参考音频1', error: '' });
  });
});
