// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GeneratorPanel from '../client/src/canvas/GeneratorPanel';
import CanvasStudio from '../client/src/canvas/CanvasStudio';
import { newDocument, newNode, type CanvasDocument } from '../client/src/canvas/model';
import { useAuthStore } from '../client/src/stores/authStore';
import { streamGeneration } from '../client/src/canvas/generation';
import { analysisApi } from '../client/src/api/analysis';
import { cropBounds } from '../client/src/canvas/ImageTools';
import { readVideoDuration } from '../client/src/canvas/videoInputs';
import { fetchVideoModels } from '../client/src/api/video';

vi.mock('../client/src/api/imageGen', () => ({ fetchImageModels: vi.fn().mockResolvedValue([{ id: 'test-image', name: 'Test Image', available: true }]), downloadGeneratedImage: vi.fn() }));
vi.mock('../client/src/api/video', () => ({ fetchVideoModels: vi.fn().mockResolvedValue([{ id: 'ad-seedance-2.5-480p', name: 'AD Multi', available: true, rates: { '480p': 1 }, allowedSeconds: [5] }, { id: 'test-video', name: 'Test Video', available: true, rates: { '720p': 1 }, allowedSeconds: [5] }, { id: 'veo-omni-flash-video-edit', name: 'Test Video Edit', available: true, rates: { '720p': 1 }, allowedSeconds: [10] }]) }));
vi.mock('../client/src/canvas/videoInputs', async importOriginal => ({ ...await importOriginal<any>(), readVideoDuration: vi.fn().mockResolvedValue(8) }));
vi.mock('../client/src/api/content', () => ({ contentApi: { getById: vi.fn().mockResolvedValue({ status: 'processing' }) } }));
vi.mock('../client/src/api/analysis', () => ({ analysisApi: { getTtsModels: vi.fn().mockResolvedValue([{ modelId: 'test-tts', displayName: 'Test Voice', voices: ['Zephyr'] }]), generateTts: vi.fn().mockResolvedValue({ mimeType: 'audio/wav', audioBase64: 'aGVsbG8=' }) } }));
vi.mock('../client/src/canvas/generation', async importOriginal => ({ ...await importOriginal<any>(), referenceDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,aGVsbG8='), streamGeneration: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', class extends MouseEvent { pointerId: number; constructor(type: string, init: any) { super(type, init); this.pointerId = init?.pointerId ?? 1; } });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  useAuthStore.setState({ user: { id: 1 } as any, isAuthenticated: true, isLoading: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function openSelectedComposer() {
  fireEvent.click(within(screen.getByRole('toolbar', {name:'所选素材操作'})).getByRole('button', {name:'创作',exact:true}));
}

function mount(initial = newDocument(), projects = [initial]) {
  let current = initial;
  const onChange = vi.fn((doc: CanvasDocument) => { current = doc; });
  render(<MemoryRouter><CanvasStudio initial={initial} projects={projects} status="已保存" onChange={onChange} onCreate={vi.fn()} onSwitch={vi.fn()} /></MemoryRouter>);
  return { current: () => current, onChange };
}

describe('canvas user workflows', () => {
  it('distinguishes node and canvas menus and acts on the right-clicked node', () => {
    const first = { ...newNode('image', { x: 0, y: 0 }), title: '原素材', src: '/original.png' };
    const second = { ...newNode('video', { x: 400, y: 0 }), title: '右击目标', src: '/target.mp4' };
    const board = mount({ ...newDocument(), nodes: [first, second] });
    fireEvent.pointerDown(screen.getByRole('article', { name: first.title }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    fireEvent.contextMenu(screen.getByRole('article', { name: second.title }));
    expect(screen.getByRole('menu', { name: '节点操作' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '上传素材' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '克隆空节点' }));
    expect(board.current().nodes).toHaveLength(3);
    expect(board.current().nodes[2]).toMatchObject({ kind: 'video', generator: true });
    expect(board.current().nodes[2].src).toBeUndefined();
    fireEvent.contextMenu(screen.getByRole('article', { name: second.title }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除节点' }));
    expect(board.current().nodes.some(n => n.id === first.id)).toBe(true);
    expect(board.current().nodes.some(n => n.id === second.id)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().nodes.some(n => n.id === second.id)).toBe(true);
  });
  it('uploads a context-menu asset at the clicked canvas position', async () => {
    const initial = newDocument();
    const board = mount(initial);
    fireEvent.contextMenu(screen.getByLabelText('无限画布编辑区'), { clientX: 240, clientY: 180 });
    fireEvent.click(screen.getByRole('menuitem', { name: '上传素材' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const input = document.querySelector('input[accept^="image/png"]')!;
    fireEvent.change(input, { target: { files: [new File(['audio'], 'reference.wav', { type: 'audio/wav' })] } });
    await waitFor(() => expect(board.current().nodes).toHaveLength(1));
    expect(board.current().nodes[0]).toMatchObject({ kind: 'audio', x: (240-initial.view.x)/initial.view.zoom, y: (180-initial.view.y)/initial.view.zoom });
    expect(streamGeneration).not.toHaveBeenCalled();
  });
  it('uploads video and audio directly into a selected node and removes references without deleting files', async () => {
    const target = { ...newNode('video', { x: 400, y: 0 }), generator: true, title: '目标' };
    const board = mount({ ...newDocument(), nodes: [target] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '目标' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    openSelectedComposer();
    fireEvent.click(screen.getByRole('button', { name: '上传参考图片 / 视频 / 音频' }));
    fireEvent.change(screen.getByLabelText('上传节点参考素材'), { target: { files: [new File(['video'], 'motion.mp4', { type: 'video/mp4' }), new File(['audio'], 'voice.wav', { type: 'audio/wav' })] } });
    await waitFor(() => expect(board.current().nodes).toHaveLength(3));
    expect(board.current().edges.map(e => e.to)).toEqual([target.id, target.id]);
    expect(board.current().nodes.slice(1).map(n => n.kind)).toEqual(['video', 'audio']);
    expect(screen.getByLabelText('试听 voice.wav')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '移除参考 voice.wav' }));
    expect(board.current().edges).toHaveLength(1); expect(board.current().nodes).toHaveLength(3);
    expect(streamGeneration).not.toHaveBeenCalled();
  });
  it('sends connected images, video and audio to multimodal generation', async () => {
    const image = { ...newNode('image', { x: 0, y: 0 }), src: '/image.png' };
    const video = { ...newNode('video', { x: 0, y: 300 }), src: '/motion.mp4' };
    const audio = { ...newNode('audio', { x: 0, y: 600 }), src: '/voice.wav' };
    const target = { ...newNode('video', { x: 500, y: 0 }), generator: true, title: '多模态目标' };
    const board = mount({ ...newDocument(), nodes: [image, video, audio, target], edges: [image, video, audio].map(n => ({ id: n.id, from: n.id, to: target.id })) });
    fireEvent.pointerDown(screen.getByRole('article', { name: target.title }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    openSelectedComposer();
    fireEvent.click(screen.getByRole('button', { name: '多模态参考' }));
    await waitFor(() => expect(screen.getByText('AD Multi', {exact:true})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '参考视频动作与音频节奏' } });
    vi.mocked(streamGeneration).mockImplementation(async (_kind, _params, _signal, cb) => cb({ type: 'complete', videoUrl: '/result.mp4' }));
    fireEvent.click(screen.getByRole('button', { name: '生成视频', exact: true }));
    await waitFor(() => expect(board.current().nodes[3].job?.status).toBe('done'));
    expect(streamGeneration).toHaveBeenCalledWith('video', expect.objectContaining({ model: 'ad-seedance-2.5-480p', reference_images: ['data:image/png;base64,aGVsbG8='], reference_videos: ['/motion.mp4'], audio_urls: ['/voice.wav'] }), expect.anything(), expect.anything());
    expect(board.current().nodes[1].src).toBe('/motion.mp4'); expect(board.current().nodes[2].src).toBe('/voice.wav');
  });
  it('uses the website catalog without a canvas whitelist and omits unavailable models', async () => {
    vi.mocked(fetchVideoModels).mockResolvedValueOnce([
      { id: 'new-admin-model', name: '后台新增模型', description: '', available: true, rates: { '720p': 1 }, allowedSeconds: [10] },
      { id: 'sd2.5-haidiyue-face', name: '网站已启用模型', description: '', available: true, rates: { '720p': 1 }, allowedSeconds: [30] },
      { id: 'unavailable', name: '不可用模型', description: '', available: false },
    ]);
    mount(); fireEvent.click(screen.getByRole('button', { name: '添加视频节点' }));
    await waitFor(() => expect(screen.getByText('后台新增模型', {exact:true})).toBeTruthy());
    fireEvent.click(screen.getByLabelText('生成模型'));
    expect(screen.getByRole('option', { name: '网站已启用模型' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '不可用模型' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: '网站已启用模型' }));
    await waitFor(() => expect((screen.getByLabelText('视频时长') as HTMLSelectElement).value).toBe('30'));
    expect(screen.getByLabelText('生成模型').closest('.studio-composer-tools')).toBeTruthy();
  });
  it('creates an editing draft, submits the original video and preserves both versions', async () => {
    const video = { ...newNode('video', { x: 0, y: 0 }), title: '原片', src: '/original.mp4' };
    const board = mount({ ...newDocument(), nodes: [video] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '原片' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '编辑视频 · 保留原片' }));
    expect(board.current().nodes).toHaveLength(2); expect(streamGeneration).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Test Video Edit', {exact:true})).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Test Video', exact: true })).toBeNull();
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '保持动作，将背景改为雪山' } });
    vi.mocked(streamGeneration).mockImplementation(async (_kind, _params, _signal, cb) => cb({ type: 'complete', videoUrl: '/edited.mp4', contentId: 93 }));
    fireEvent.click(screen.getByRole('button', { name: '生成视频', exact: true }));
    await waitFor(() => expect(board.current().nodes[1].job?.status).toBe('done'));
    expect(readVideoDuration).toHaveBeenCalledWith('/original.mp4', expect.any(AbortSignal));
    expect(streamGeneration).toHaveBeenCalledWith('video', expect.objectContaining({ model: 'veo-omni-flash-video-edit', reference_videos: ['/original.mp4'], video_length: 10 }), expect.anything(), expect.anything());
    expect(board.current().nodes[0].src).toBe('/original.mp4');
    expect(board.current().nodes[1].versions?.[0].src).toBe('/edited.mp4');
  });
  it('does not submit or bill when original video metadata fails validation', async () => {
    const video = { ...newNode('video', { x: 0, y: 0 }), title: '长视频', src: '/long.mp4' };
    const board = mount({ ...newDocument(), nodes: [video] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '长视频' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '编辑视频 · 保留原片' }));
    await waitFor(() => expect(screen.getByText('Test Video Edit', {exact:true})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '修改背景' } });
    vi.mocked(readVideoDuration).mockRejectedValueOnce(new Error('原视频超过 15 秒'));
    fireEvent.click(screen.getByRole('button', { name: '生成视频', exact: true }));
    await waitFor(() => expect(board.current().nodes[1].job?.status).toBe('error'));
    expect(streamGeneration).not.toHaveBeenCalled(); expect(board.current().nodes[0].src).toBe('/long.mp4');
  });
  it('offers node types on a blank connection drop and creates the node and edge as one undo step', async () => {
    const source = { ...newNode('image', { x: 0, y: 0 }), title: '起点' };
    const board = mount({ ...newDocument(), nodes: [source], view: { x: 20, y: 30, zoom: .5 } });
    const stage = screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerDown(screen.getByRole('button', { name: '从 起点 连接' }), { button: 0, clientX: 170, clientY: 97.5, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 400, clientY: 240, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 400, clientY: 240, pointerId: 1 });
    expect(screen.getByRole('menu', { name: '添加并连接节点' })).toBeTruthy();
    expect(board.current().nodes).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitem', { name: '添加视频节点' }));
    expect(board.current().nodes[1]).toMatchObject({ kind: 'video', x: 760, y: 285, generator: true });
    expect(board.current().edges[0]).toMatchObject({ from: source.id, to: board.current().nodes[1].id });
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().nodes).toHaveLength(1); expect(board.current().edges).toHaveLength(0);
    await act(async () => {});
  });
  it('creates upstream nodes on reverse drag and cancels the menu without modifying the board', async () => {
    const target = { ...newNode('video', { x: 500, y: 0 }), title: '终点' };
    const board = mount({ ...newDocument(), nodes: [target] });
    const stage = screen.getByLabelText('无限画布编辑区');
    const drag = () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: '连接到 终点' }), { button: 0, clientX: 500, clientY: 135, pointerId: 1 });
      fireEvent.pointerMove(stage, { clientX: 350, clientY: 350, pointerId: 1 });
      fireEvent.pointerUp(stage, { clientX: 350, clientY: 350, pointerId: 1 });
    };
    drag(); fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull(); expect(board.current().nodes).toHaveLength(1);
    drag(); fireEvent.click(screen.getByRole('menuitem', { name: '添加图像节点' }));
    expect(board.current().nodes[1]).toMatchObject({ x: 50, y: 215 });
    expect(board.current().edges[0]).toMatchObject({ from: board.current().nodes[1].id, to: target.id });
    await act(async () => {});
  });
  it('creates batch drafts without submitting and preserves each prompt', async () => {
    const board = mount();
    fireEvent.click(screen.getByRole('button', { name: '批量节点' }));
    fireEvent.change(screen.getByLabelText('批量节点提示词'), { target: { value: '晨雾湖泊\n日落湖泊\n星空湖泊' } });
    fireEvent.click(screen.getByRole('button', { name: '创建节点 · 不产生生成费用' }));
    expect(board.current().nodes.map(n => n.text)).toEqual(['晨雾湖泊', '日落湖泊', '星空湖泊']);
    expect(board.current().nodes.every(n => n.generator)).toBe(true);
    expect(streamGeneration).not.toHaveBeenCalled();
    await act(async () => {});
  });
  it('regenerates in the same node, keeps earlier images, and does not multiply connected text', async () => {
    const note = { ...newNode('text', { x: 0, y: 0 }, '一致的角色设定'), title: '上下文' };
    const generator = { ...newNode('image', { x: 400, y: 0 }, '第一次提示词'), generator: true, src: '/previous.png', title: '生成节点' };
    const board = mount({ ...newDocument(), nodes: [note, generator], edges: [{ id: 'ref', from: note.id, to: generator.id }] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '生成节点' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    openSelectedComposer();
    await waitFor(() => expect(screen.getByText('Test Image', {exact:true})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '新的场景' } });
    fireEvent.change(screen.getByLabelText('生成数量'), { target: { value: '2' } });
    vi.mocked(streamGeneration).mockImplementation(async (_kind, _params, _signal, cb) => { cb({ type: 'image_ready', imageUrl: '/one.png' }); cb({ type: 'complete', imageUrls: ['/one.png', '/two.png'] }); });
    fireEvent.click(screen.getByRole('button', { name: '生成图像', exact: true }));
    await waitFor(() => expect(board.current().nodes[1].job?.status).toBe('done'));
    expect(board.current().nodes).toHaveLength(2);
    expect(board.current().nodes[1].versions?.map(v => v.src)).toEqual(['/previous.png', '/one.png', '/two.png']);
    expect(board.current().drafts?.[generator.id].prompt).toBe('新的场景');
    expect(streamGeneration).toHaveBeenCalledWith('image', expect.objectContaining({ prompt: '一致的角色设定\n\n新的场景', n: 2 }), expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '节点历史 · 3' }));
    fireEvent.click(screen.getAllByRole('button', { name: '设为当前版本' })[2]);
    expect(board.current().nodes[1].src).toBe('/previous.png');
  });
  it('computes centered crops without stretching either landscape or portrait images', () => {
    expect(cropBounds(1600, 900, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(cropBounds(900, 1600, 1)).toEqual({ x: 0, y: 350, width: 900, height: 900 });
    expect(cropBounds(1600, 900, 0)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
  });
  it('generates audio through the existing TTS service and retains a playable version', async () => {
    const board = mount();
    fireEvent.click(screen.getByRole('button', { name: '添加音频节点' }));
    await waitFor(() => expect(screen.getByText('Test Voice', {exact:true})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '欢迎来到创作画布' } });
    fireEvent.click(screen.getByRole('button', { name: '生成音频' }));
    await waitFor(() => expect(board.current().nodes[0].job?.status).toBe('done'));
    expect(analysisApi.generateTts).toHaveBeenCalledWith('欢迎来到创作画布', 'Zephyr', 'test-tts');
    expect(board.current().nodes[0].versions?.[0].src).toBe('data:audio/wav;base64,aGVsbG8=');
    expect(streamGeneration).not.toHaveBeenCalled();
  });
  it('adds a connected next node in one reversible step', async () => {
    const reference = { ...newNode('image', { x: 0, y: 0 }), title: '起始图', src: '/original.png' };
    const board = mount({ ...newDocument(), nodes: [reference] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '起始图' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '＋ 连接下一步' }));
    expect(board.current().nodes).toHaveLength(2); expect(board.current().edges).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().nodes).toHaveLength(1); expect(board.current().edges).toHaveLength(0);
    await act(async () => {});
  });
  it('drags a connection under zoom without moving cards and creates one undo step', async () => {
    const a = { ...newNode('image', { x: 0, y: 0 }), title: '起点' }, b = { ...newNode('image', { x: 500, y: 0 }), title: '终点' };
    const board = mount({ ...newDocument(), nodes: [a, b], view: { x: 15, y: 30, zoom: .5 } });
    const port = screen.getByRole('button', { name: '从 起点 连接' }), stage = screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerDown(port, { button: 0, clientX: 165, clientY: 97.5, pointerId: 7 });
    fireEvent.pointerMove(stage, { clientX: 260, clientY: 97.5, pointerId: 7 });
    expect(screen.getByTestId('connection-preview')).toBeTruthy();
    expect(screen.getByRole('button', { name: '连接到 终点' }).className).toContain('link-valid');
    fireEvent.pointerUp(stage, { clientX: 260, clientY: 97.5, pointerId: 7 });
    fireEvent.click(port, { detail: 1 });
    expect(board.current().edges).toEqual([expect.objectContaining({ from: a.id, to: b.id })]);
    expect(board.current().nodes.map(n => n.x)).toEqual([0, 500]);
    expect(screen.queryByTestId('connection-preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().edges).toHaveLength(0);
    await act(async () => {});
  });
  it('supports dragging backwards from an input to an output and rejects cycles', async () => {
    const a = { ...newNode('image', { x: 0, y: 0 }), title: '起点' }, b = { ...newNode('image', { x: 500, y: 0 }), title: '终点' };
    const board = mount({ ...newDocument(), nodes: [a, b] });
    const stage = screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerDown(screen.getByRole('button', { name: '连接到 终点' }), { button: 0, clientX: 500, clientY: 135, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 300, clientY: 135, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 300, clientY: 135, pointerId: 1 });
    expect(board.current().edges[0]).toMatchObject({ from: a.id, to: b.id });
    fireEvent.pointerDown(screen.getByRole('button', { name: '从 终点 连接' }), { button: 0, clientX: 800, clientY: 135, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 0, clientY: 135, pointerId: 2 });
    expect(screen.getByRole('button', { name: '连接到 起点' }).className).toContain('link-invalid');
    fireEvent.pointerUp(stage, { clientX: 0, clientY: 135, pointerId: 2 });
    expect(board.current().edges).toHaveLength(1);
    await act(async () => {});
  });
  it('cancels connection drags on blank release, Escape and pointer cancellation', async () => {
    const a = { ...newNode('image', { x: 0, y: 0 }), title: '起点' }, b = { ...newNode('image', { x: 500, y: 0 }), title: '终点' };
    const board = mount({ ...newDocument(), nodes: [a, b] });
    const stage = screen.getByLabelText('无限画布编辑区'), port = screen.getByRole('button', { name: '从 起点 连接' });
    for (const action of ['blank', 'escape', 'cancel']) {
      fireEvent.pointerDown(port, { button: 0, clientX: 300, clientY: 135, pointerId: 1 });
      fireEvent.pointerMove(stage, { clientX: 500, clientY: 135, pointerId: 1 });
      if (action === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      if (action === 'cancel') fireEvent.pointerCancel(stage, { pointerId: 1 });
      else fireEvent.pointerUp(stage, { clientX: action === 'blank' ? 900 : 500, clientY: 135, pointerId: 1 });
      expect(board.current().edges).toHaveLength(0);
      expect(screen.queryByTestId('connection-preview')).toBeNull();
    }
    await act(async () => {});
  });
  it('turns an image into a connected video draft without automatically submitting', async () => {
    const reference = { ...newNode('image', { x: 0, y: 0 }), title: '参考图', src: '/uploads/reference.png' };
    const board = mount({ ...newDocument(), nodes: [reference] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '参考图' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: '生成视频', exact: true }));
    expect(board.current().nodes[1].kind).toBe('video');
    expect(board.current().nodes[1].origin?.nodeId).toBe(reference.id);
    expect(board.current().edges[0].from).toBe(reference.id);
    expect(streamGeneration).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('生成模型').getAttribute('disabled')).toBeNull());
    fireEvent.click(screen.getByLabelText('生成模型'));
    expect(screen.getByRole('option', {name:'Test Video'})).toBeTruthy();
    expect((screen.getByLabelText('你想创作什么？') as HTMLTextAreaElement).value).toContain('镜头');
  });
  it('compares two selected versions and closes with Escape without deleting assets', async () => {
    const a = { ...newNode('image', { x: 0, y: 0 }), src: '/a.png', title: '版本一' };
    const b = { ...newNode('image', { x: 400, y: 0 }), src: '/b.png', title: '版本二' };
    const board = mount({ ...newDocument(), nodes: [a, b] });
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: '并排对比这两张图' }));
    expect(screen.getByRole('dialog', { name: '版本对比' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Delete' }); expect(board.current().nodes).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog', { name: '版本对比' })).toBeNull();
    await act(async () => {});
  });
  it('retains the composer draft when closing and reopening the panel', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '创作', exact: true }));
    await waitFor(() => expect(screen.getByText('Test Image', {exact:true})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '保留我的未提交提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '收起创作面板' }));
    fireEvent.click(screen.getByRole('button', { name: '创作', exact: true }));
    expect((screen.getByLabelText('你想创作什么？') as HTMLTextAreaElement).value).toBe('保留我的未提交提示词');
    await act(async () => {});
  });
  it('reuses another project asset without moving the original or copying task identity', async () => {
    const current = newDocument(), other = newDocument('其他项目');
    const asset = { ...newNode('image', { x: 0, y: 0 }), src: '/asset.png', title: '其他图像', job: { status: 'done' as const, contentId: 88, message: '' } };
    other.nodes = [asset]; let changed = current;
    render(<MemoryRouter><CanvasStudio initial={current} projects={[current, other]} status="已保存" onChange={doc => { changed = doc; }} onCreate={vi.fn()} onSwitch={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '素材列表' }));
    fireEvent.click(screen.getByRole('button', { name: '跨项目', exact:true }));
    fireEvent.click(screen.getByRole('button', { name: /^参考素材/ }));
    fireEvent.click(screen.getByRole('button', { name: /其他图像\s*其他项目/ }));
    expect(changed.nodes[0].src).toBe(asset.src); expect(changed.nodes[0].id).not.toBe(asset.id);
    expect(changed.nodes[0].job).toBeUndefined(); expect(changed.nodes[0].origin?.projectId).toBe(other.id);
    expect(other.nodes[0]).toBe(asset); await act(async () => {});
  });
  it('adds a note, edits it, deletes it, and restores it with undo', async () => {
    const board = mount();
    fireEvent.click(screen.getByRole('button', { name: '添加文字', exact: true }));
    const note = screen.getByLabelText('卡片文字');
    fireEvent.focus(note); fireEvent.change(note, { target: { value: '一个新的故事' } }); fireEvent.blur(note);
    expect(board.current().nodes[0].text).toBe('一个新的故事');
    fireEvent.click(screen.getByRole('button', { name: '删除所选', exact: true }));
    expect(board.current().nodes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().nodes[0].text).toBe('一个新的故事');
    await act(async () => {});
  });
  it('treats a multi-move as one undo step at non-default zoom', async () => {
    const a = newNode('text', { x: 0, y: 0 }), b = newNode('image', { x: 400, y: 0 });
    const board = mount({ ...newDocument(), nodes: [a, b], view: { x: 0, y: 0, zoom: .5 } });
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    const node = screen.getByRole('article', { name: '灵感笔记' }), stage = screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerDown(node, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(board.current().nodes.map(n => n.x)).toEqual([100, 500]);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().nodes.map(n => n.x)).toEqual([0, 400]);
    await act(async () => {});
  });
  it('does not delete canvas assets when Backspace is used in a text editor', async () => {
    const board = mount(); fireEvent.click(screen.getByRole('button', { name: '添加文字', exact: true }));
    fireEvent.keyDown(screen.getByLabelText('卡片文字'), { key: 'Backspace' });
    expect(board.current().nodes).toHaveLength(1);
    await act(async () => {});
  });
  it('creates editable templates without sending paid generation requests', async () => {
    const board = mount(); fireEvent.click(screen.getByRole('button', { name: /短片分镜/ }));
    expect(board.current().nodes).toHaveLength(4); expect(board.current().edges).toHaveLength(1);
    expect(streamGeneration).not.toHaveBeenCalled();
    await act(async () => {});
  });
  it('connects a note and image placeholder and can undo the connection', async () => {
    const a = { ...newNode('text', { x: 0, y: 0 }), title: '故事' }, b = { ...newNode('image', { x: 400, y: 0 }), title: '画面' };
    const board = mount({ ...newDocument(), nodes: [a, b] });
    fireEvent.click(screen.getByRole('button', { name: '从 故事 连接', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '连接到 画面', exact: true }));
    expect(board.current().edges).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    expect(board.current().edges).toHaveLength(0);
    await act(async () => {});
  });
  it('places generated results on a separate node and preserves reference images', async () => {
    const reference = { ...newNode('image', { x: 0, y: 0 }), title: '参考图', src: 'data:image/png;base64,aGVsbG8=' };
    const board = mount({ ...newDocument(), nodes: [reference] });
    fireEvent.pointerDown(screen.getByRole('article', { name: '参考图' }), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'), { pointerId: 1 });
    openSelectedComposer();
    await waitFor(() => expect(screen.getByText('Test Image', {exact:true})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('你想创作什么？'), { target: { value: '一片宁静的森林' } });
    vi.mocked(streamGeneration).mockImplementation(async (_kind, _params, _signal, callback) => {
      callback({ type: 'status', contentId: 42 });
      callback({ type: 'image_ready', imageUrl: '/uploads/test-result.png' });
      callback({ type: 'complete' });
    });
    fireEvent.click(screen.getByRole('button', { name: '生成图像', exact: true }));
    await waitFor(() => expect(board.current().nodes[1]?.job?.status).toBe('done'));
    expect(board.current().nodes[0].src).toBe(reference.src);
    expect(board.current().nodes[1].src).toBe('/uploads/test-result.png');
    expect(board.current().edges[0].from).toBe(reference.id);
    expect(streamGeneration).toHaveBeenCalledWith('image', expect.objectContaining({ prompt: '一片宁静的森林', reference_images: [reference.src] }), expect.anything(), expect.anything());
  });
});



describe('linked reference feedback', () => {
  it('shows an empty connected node and prevents generation until it has content', async () => {
    const reference = { ...newNode('image', {x:0,y:0}), title:'待上传参考' };
    render(<MemoryRouter><GeneratorPanel references={[reference]} busy={false} onClose={vi.fn()} onGenerate={vi.fn()} onConnect={vi.fn()} draft={{kind:'image',prompt:'test',model:'test-image',ratio:'16:9',resolution:'1K',seconds:5}} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText('生成模型').getAttribute('disabled')).toBeNull());
    expect(screen.getByText('待上传参考 · 待添加内容')).toBeTruthy();
    expect((screen.getByRole('button', {name:'生成图像'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('switches text-to-video to image reference when an image is connected', async () => {
    const onDraft=vi.fn();
    render(<MemoryRouter><GeneratorPanel references={[{...newNode('image',{x:0,y:0}),src:'/ref.png'}]} busy={false} onDraft={onDraft} onClose={vi.fn()} onGenerate={vi.fn()} onConnect={vi.fn()} draft={{kind:'video',videoMode:'text',prompt:'test',model:'test-video',ratio:'16:9',resolution:'720p',seconds:5}} /></MemoryRouter>);
    await waitFor(() => expect(onDraft.mock.lastCall?.[0].videoMode).toBe('reference'));
  });
  it('switches connected video/audio to a capable multimodal model', async () => {
    const onDraft=vi.fn();
    render(<MemoryRouter><GeneratorPanel references={[{...newNode('audio',{x:0,y:0}),src:'/ref.wav'}]} busy={false} onDraft={onDraft} onClose={vi.fn()} onGenerate={vi.fn()} onConnect={vi.fn()} draft={{kind:'video',videoMode:'reference',prompt:'test',model:'test-video',ratio:'16:9',resolution:'720p',seconds:5}} /></MemoryRouter>);
    await waitFor(() => expect(onDraft.mock.lastCall?.[0]).toMatchObject({videoMode:'multimodal',model:'ad-seedance-2.5-480p'}));
  });
});


describe('reference order controls', () => {
  it('moves references without deleting their source nodes', async () => {
    const first={...newNode('image',{x:0,y:0}),src:'/one.png',title:'参考一'};
    const second={...newNode('image',{x:0,y:0}),src:'/two.png',title:'参考二'};
    const reorder=vi.fn();
    render(<MemoryRouter><GeneratorPanel references={[first,second]} busy={false} onReorderReference={reorder} onClose={vi.fn()} onGenerate={vi.fn()} onConnect={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'前移参考 参考二'}));
    expect(reorder).toHaveBeenCalledWith(second.id,-1);
    expect((screen.getByRole('button',{name:'前移参考 参考一'}) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(()=>expect(screen.getByLabelText('生成模型').getAttribute('disabled')).toBeNull());
  });
});


describe('composer popups', () => {
  it('opens only one popup, searches models and dismisses on Escape', async () => {
    render(<MemoryRouter><GeneratorPanel references={[]} busy={false} onClose={vi.fn()} onGenerate={vi.fn()} onConnect={vi.fn()} /></MemoryRouter>);
    await waitFor(()=>expect(screen.getByText('Test Image',{exact:true})).toBeTruthy());
    fireEvent.click(screen.getByLabelText('生成参数'));
    expect(screen.getByRole('dialog',{name:'生成参数设置'})).toBeTruthy();
    fireEvent.click(screen.getByLabelText('生成模型'));
    expect(screen.queryByRole('dialog',{name:'生成参数设置'})).toBeNull();
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索模型'),{target:{value:'not-found'}});
    expect(screen.getByText('未找到匹配模型')).toBeTruthy();
    fireEvent.keyDown(document,{key:'Escape'});
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByLabelText('生成模型'));
    fireEvent.click(screen.getByLabelText('生成参数'));
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog',{name:'生成参数设置'})).toBeNull();
  });
});


describe('asset library reuse', () => {
  it('references an existing project node without duplicating it', async () => {
    const source={...newNode('image',{x:0,y:0}),src:'/reference.png',title:'已有图片'};
    const target={...newNode('image',{x:400,y:0}),generator:true,title:'目标'};
    const board=mount({...newDocument(),nodes:[source,target]});
    fireEvent.pointerDown(screen.getByRole('article',{name:'目标'}),{button:0,pointerId:1});
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'),{pointerId:1});
    openSelectedComposer();
    fireEvent.click(screen.getByRole('button',{name:'从素材库引用'}));
    fireEvent.click(screen.getByRole('button',{name:'引用为参考',exact:true}));
    expect(board.current().nodes).toHaveLength(2);
    expect(board.current().edges).toEqual([expect.objectContaining({from:source.id,to:target.id})]);
    expect(board.current().nodes[0].src).toBe('/reference.png');
    await waitFor(()=>expect(screen.getByLabelText('生成模型').getAttribute('disabled')).toBeNull());
  });
  it('fills an empty node and preserves its identity and links', async () => {
    const source={...newNode('image',{x:0,y:0}),src:'/reference.png',title:'已有图片'};
    const target={...newNode('image',{x:400,y:0}),generator:true,title:'目标'};
    const edge={id:'existing',from:source.id,to:target.id};
    const board=mount({...newDocument(),nodes:[source,target],edges:[edge]});
    fireEvent.click(screen.getByRole('button',{name:'从素材库选择 / 上传'}));
    fireEvent.click(screen.getByRole('button',{name:'填入节点',exact:true}));
    expect(board.current().nodes).toHaveLength(2);
    expect(board.current().nodes[1]).toMatchObject({id:target.id,src:'/reference.png'});
    expect(board.current().edges).toEqual([edge]);
    await waitFor(()=>expect(screen.getByLabelText('生成模型').getAttribute('disabled')).toBeNull());
  });
});


it('copies cross-project references while preserving the original project', async () => {
  const source={...newNode('image',{x:0,y:0}),src:'/other.png',title:'其他项目素材'};
  const target={...newNode('image',{x:0,y:0}),generator:true,title:'当前目标'};
  const current={...newDocument(),nodes:[target]}, other={...newDocument('另一个项目'),nodes:[source]};
  const board=mount(current,[current,other]);
  fireEvent.pointerDown(screen.getByRole('article',{name:'当前目标'}),{button:0,pointerId:1});
  fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'),{pointerId:1});
    openSelectedComposer();
  fireEvent.click(screen.getByRole('button',{name:'从素材库引用'}));
  fireEvent.click(screen.getByRole('button',{name:'跨项目素材'}));
  fireEvent.click(screen.getByRole('button',{name:'引用为参考',exact:true}));
  expect(board.current().nodes).toHaveLength(2);
  const copy=board.current().nodes[1];expect(copy.id).not.toBe(source.id);
  expect(copy).toMatchObject({src:'/other.png',origin:{projectId:other.id,nodeId:source.id}});
  expect(board.current().edges[0]).toMatchObject({from:copy.id,to:target.id});
  expect(other.nodes).toEqual([source]);
  await waitFor(()=>expect(screen.getByLabelText('生成模型').getAttribute('disabled')).toBeNull());
});


describe('project library folders', () => {
  it('creates a saved folder, moves an asset and filters it in grid view', () => {
    const node={...newNode('image',{x:0,y:0}),title:'产品参考',src:'/product.png'};
    const board=mount({...newDocument(),nodes:[node]});
    fireEvent.click(screen.getByRole('button',{name:'素材列表'}));
    fireEvent.click(screen.getByRole('button',{name:'新建素材文件夹'}));
    fireEvent.change(screen.getByLabelText('文件夹名称'),{target:{value:'产品系列'}});
    fireEvent.click(screen.getByRole('button',{name:'创建',exact:true}));
    expect(board.current().assetFolders).toContain('产品系列');
    fireEvent.click(screen.getByRole('button',{name:'产品系列',exact:true}));
    fireEvent.click(screen.getByRole('button',{name:/^参考素材/}));
    fireEvent.change(screen.getByLabelText('移动素材 产品参考'),{target:{value:'产品系列'}});
    expect(board.current().nodes[0].assetFolder).toBe('产品系列');
    fireEvent.click(screen.getByRole('button',{name:'参考素材',exact:true}));
    fireEvent.click(screen.getByRole('button',{name:/^产品系列/}));
    fireEvent.click(screen.getByRole('button',{name:'网格视图'}));
    expect(screen.getByRole('button',{name:'网格视图'}).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('移动素材 产品参考')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索画布素材'),{target:{value:'不存在'}});
    expect(screen.getByText('暂无符合条件的素材')).toBeTruthy();
  });
});


describe('prompt reference mentions', () => {
  it('inserts a mouse-picked reference before blur can dismiss the menu, preserving surrounding text', async () => {
    const image={...newNode('image',{x:0,y:0}),title:'角色参考',src:'/actor.png'};
    render(<MemoryRouter><GeneratorPanel references={[image]} busy={false} onGenerate={vi.fn()} onClose={vi.fn()} onConnect={vi.fn()}/></MemoryRouter>);
    const input=screen.getByLabelText('你想创作什么？') as HTMLTextAreaElement;
    fireEvent.change(input,{target:{value:'角色=@；保留后文',selectionStart:4}});
    const option=screen.getByRole('option',{name:/角色参考/});
    fireEvent.pointerDown(option,{button:0,pointerId:1});
    fireEvent.mouseDown(option,{button:0});
    fireEvent.blur(input,{relatedTarget:null});
    expect(input.value).toBe('角色=@图片1 ；保留后文');
    expect(screen.queryByRole('listbox',{name:'可引用素材'})).toBeNull();
    await waitFor(()=>expect(input.selectionStart).toBe(8));
  });

  it('keeps the menu available during pointer focus changes and reports failed insertions', async () => {
    const image={...newNode('image',{x:0,y:0}),title:'角色参考',src:'/actor.png'};
    render(<MemoryRouter><GeneratorPanel references={[image]} busy={false} onGenerate={vi.fn()} onClose={vi.fn()} onConnect={vi.fn()}/></MemoryRouter>);
    const input=screen.getByLabelText('你想创作什么？') as HTMLTextAreaElement;
    fireEvent.change(input,{target:{value:'文'.repeat(4999)+'@',selectionStart:5000}});
    const option=screen.getByRole('option',{name:/角色参考/});
    fireEvent.pointerDown(option,{pointerId:1});
    fireEvent.blur(input,{relatedTarget:null});
    expect(screen.getByRole('listbox',{name:'可引用素材'})).toBeTruthy();
    fireEvent.pointerUp(option,{pointerId:1});
    fireEvent.click(option);
    expect(screen.getByRole('alert').textContent).toContain('5000');
    expect(input.value.length).toBe(5000);
    await waitFor(()=>expect(screen.getByRole('button',{name:'生成模型'}).textContent).toContain('Test Image'));
  });
  it('shows distinct reference thumbnails, inserts by keyboard, and submits the matching image ordinal', async () => {
    const first={...newNode('image',{x:0,y:0}),title:'小狗',src:'/dog.png'};
    const second={...newNode('image',{x:0,y:0}),title:'花园',src:'/garden.png'};
    const onGenerate=vi.fn();
    const props={references:[first,second],busy:false,onGenerate,onClose:vi.fn(),onConnect:vi.fn()};
    const view=render(<MemoryRouter><GeneratorPanel {...props}/></MemoryRouter>);
    await waitFor(()=>expect(screen.getByRole('button',{name:'生成模型'}).textContent).toContain('Test Image'));
    const input=screen.getByLabelText('你想创作什么？');
    fireEvent.change(input,{target:{value:'让@',selectionStart:2}});
    expect(screen.getByRole('listbox',{name:'可引用素材'})).toBeTruthy();
    expect(screen.getAllByRole('option').some(n=>n.textContent?.includes('小狗'))).toBe(true);
    fireEvent.keyDown(input,{key:'Enter'});
    expect((input as HTMLTextAreaElement).value).toBe('让@图片1 ');
    view.rerender(<MemoryRouter><GeneratorPanel {...props} references={[second,first]}/></MemoryRouter>);
    fireEvent.click(screen.getByRole('button',{name:'生成图像'}));
    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({prompt:'让参考图片2',inputPrompt:'让@图片1 '}));
    view.rerender(<MemoryRouter><GeneratorPanel {...props} references={[second]}/></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('已断开');
    expect((screen.getByRole('button',{name:'生成图像'}) as HTMLButtonElement).disabled).toBe(true);
  });

  it('chooses an unconnected canvas image and connects it before generation', async () => {
    const image={...newNode('image',{x:0,y:0}),title:'花园参考',src:'/garden.png'};
    const target={...newNode('image',{x:400,y:0}),title:'生成目标',generator:true};
    const board=mount({...newDocument(),nodes:[image,target]});
    fireEvent.pointerDown(screen.getByRole('article',{name:target.title}),{button:0,pointerId:1});
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'),{pointerId:1});
    openSelectedComposer();
    const input=await screen.findByLabelText('你想创作什么？');
    fireEvent.change(input,{target:{value:'@',selectionStart:1}});
    fireEvent.click(screen.getByRole('button',{name:'本项目 / 画布'}));
    fireEvent.click(screen.getByRole('option',{name:/花园参考/}));
    expect(board.current().edges.some(e=>e.from===image.id&&e.to===target.id)).toBe(true);
    expect((screen.getByLabelText('你想创作什么？') as HTMLTextAreaElement).value).toBe('@图片1 ');
    expect(board.current().drafts?.[target.id].referenceBindings?.['图片1']).toBe(image.id);
  });
});


describe('cross-project prompt references',()=>{
  it('copies a source into the active project and binds the mention to that local node',async()=>{
    const source={...newNode('image',{x:0,y:0}),title:'其他项目的角色',src:'/actor.png'};
    const target={...newNode('image',{x:400,y:0}),title:'角色生成',generator:true};
    const document={...newDocument(),nodes:[target]};
    const other={...newDocument('角色库'),nodes:[source]};
    const board=mount(document,[document,other]);
    fireEvent.pointerDown(screen.getByRole('article',{name:target.title}),{button:0,pointerId:1});
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'),{pointerId:1});
    openSelectedComposer();
    const input=await screen.findByLabelText('你想创作什么？');
    fireEvent.change(input,{target:{value:'@',selectionStart:1}});
    fireEvent.click(screen.getByRole('button',{name:'跨项目'}));
    fireEvent.click(screen.getByRole('option',{name:/其他项目的角色/}));
    const local=board.current().nodes.find(n=>n.src===source.src)!;
    expect(local.id).not.toBe(source.id);
    expect(local.origin?.projectId).toBe(other.id);
    expect(board.current().edges.some(e=>e.from===local.id&&e.to===target.id)).toBe(true);
    expect(board.current().drafts?.[target.id].referenceBindings?.['图片1']).toBe(local.id);
    expect(other.nodes).toEqual([source]);
  });
});


describe('composer node anchoring',()=>{
  it.each([false,true])('opens creation by double-clicking a node (has media: %s)', async hasMedia => {
    const node={...newNode('image',{x:100,y:100}),title:'双击创作',src:hasMedia ? '/image.png' : undefined};
    mount({...newDocument(),nodes:[node]});
    const card=screen.getByRole('article',{name:node.title});
    fireEvent.pointerDown(card,{button:0,pointerId:1});
    fireEvent.pointerUp(card,{pointerId:1});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    fireEvent.doubleClick(hasMedia ? screen.getByRole('img',{name:node.title}) : screen.getByRole('button',{name:/下一张好作品/}));
    expect(await screen.findByLabelText('创作面板')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(()=>expect(screen.getByLabelText('生成模型').textContent).toContain('Test Image'));
  });
  it('does not add notes when double-clicking canvas whitespace', () => {
    const board=mount();
    fireEvent.doubleClick(screen.getByLabelText('无限画布编辑区'),{clientX:350,clientY:200});
    expect(board.current().nodes).toHaveLength(0);
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'添加文字',exact:true}));
    expect(board.current().nodes).toHaveLength(1);
    expect(board.current().nodes[0].kind).toBe('text');
  });
  it('requires an explicit creation action and never opens on selection or dragging, preserving the draft', async () => {
    const node={...newNode('image',{x:100,y:100}),title:'移动素材',src:'/image.png',generator:true};
    const board=mount({...newDocument(),nodes:[node],view:{x:0,y:0,zoom:1}});
    const card=screen.getByRole('article',{name:node.title});
    const surface=screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerDown(card,{button:0,pointerId:1,clientX:120,clientY:120});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    fireEvent.pointerUp(surface,{pointerId:1,clientX:120,clientY:120});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    openSelectedComposer();
    const input=await screen.findByLabelText('你想创作什么？');
    fireEvent.change(input,{target:{value:'保留这段创作提示词'}});
    const viewBefore=board.current().view;
    fireEvent.pointerDown(card,{button:0,pointerId:2,clientX:120,clientY:120});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    fireEvent.pointerMove(surface,{pointerId:2,clientX:200,clientY:160});
    fireEvent.pointerUp(surface,{pointerId:2,clientX:200,clientY:160});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    expect(board.current().nodes[0].x).toBeCloseTo(100+80/viewBefore.zoom);
    expect(board.current().nodes[0].y).toBeCloseTo(100+40/viewBefore.zoom);
    expect(board.current().view).toEqual(viewBefore);
    expect(board.current().drafts?.[node.id].prompt).toBe('保留这段创作提示词');
    fireEvent.pointerDown(card,{button:0,pointerId:3});
    fireEvent.pointerUp(surface,{pointerId:3});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    openSelectedComposer();
    expect((await screen.findByLabelText('你想创作什么？') as HTMLTextAreaElement).value).toBe('保留这段创作提示词');
  });

  it('allows dragging the empty node body without opening the composer, and ignores cancelled clicks', () => {
    const node={...newNode('video',{x:0,y:0}),title:'空视频',generator:true};
    const board=mount({...newDocument(),nodes:[node],view:{x:0,y:0,zoom:1}});
    const body=screen.getByRole('button',{name:/让画面动起来/});
    const surface=screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerDown(body,{button:0,pointerId:1,clientX:100,clientY:100});
    fireEvent.pointerMove(surface,{pointerId:1,clientX:150,clientY:160});
    fireEvent.pointerUp(surface,{pointerId:1,clientX:150,clientY:160});
    fireEvent.click(body,{detail:1});
    expect(board.current().nodes[0]).toMatchObject({x:50,y:60});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    fireEvent.pointerDown(body,{button:0,pointerId:2});
    fireEvent.pointerCancel(surface,{pointerId:2});
    expect(screen.queryByLabelText('创作面板')).toBeNull();
    fireEvent.click(body);
    expect(screen.queryByLabelText('创作面板')).toBeNull();
  });
  it.each([0.5,1,2])('keeps the composer below and centered on the node at zoom %s',async zoom=>{
    const node={...newNode('image',{x:400,y:300}),title:'位置检查',generator:true};
    const board=mount({...newDocument(),nodes:[node],view:{x:30,y:-10,zoom}});
    fireEvent.pointerDown(screen.getByRole('article',{name:node.title}),{button:0,pointerId:1});
    fireEvent.pointerUp(screen.getByLabelText('无限画布编辑区'),{pointerId:1});
    openSelectedComposer();
    const panel=await screen.findByLabelText('创作面板');
    const anchor=panel.closest('.studio-composer-anchor') as HTMLElement;
    const assertAnchored=()=>{
      const view=board.current().view;
      expect(parseFloat(anchor.style.top)).toBeCloseTo((node.y+node.height)*view.zoom+view.y+16);
      expect(parseFloat(anchor.style.left)+parseFloat(anchor.style.width)/2).toBeCloseTo((node.x+node.width/2)*view.zoom+view.x);
    };
    assertAnchored();
    fireEvent.click(screen.getByRole('button',{name:'放大画布'}));
    assertAnchored();
    fireEvent.click(screen.getByRole('button',{name:'缩小画布'}));
    assertAnchored();
  });
});

describe('batch video references', () => {
  it('connects all selected ready assets once, skips cycles and empty nodes, and undoes in one step', () => {
    const image={...newNode('image',{x:0,y:0}),src:'/image.png'};
    const audio={...newNode('audio',{x:0,y:300}),src:'/voice.wav'};
    const text={...newNode('text',{x:0,y:600}),text:'角色设定'};
    const empty=newNode('image',{x:0,y:900});
    const downstream={...newNode('video',{x:900,y:0}),src:'/downstream.mp4'};
    const target={...newNode('video',{x:500,y:0}),title:'目标视频',generator:true};
    const edges=[{id:'existing',from:image.id,to:target.id},{id:'cycle',from:target.id,to:downstream.id}];
    const board=mount({...newDocument(),nodes:[image,audio,text,empty,downstream,target],edges});
    fireEvent.keyDown(window,{key:'a',ctrlKey:true});
    fireEvent.change(screen.getByLabelText('批量连接到视频节点'),{target:{value:target.id}});
    expect(board.current().edges).toHaveLength(4);
    expect(board.current().edges.filter(e=>e.to===target.id).map(e=>e.from)).toEqual([image.id,audio.id,text.id]);
    fireEvent.change(screen.getByLabelText('批量连接到视频节点'),{target:{value:target.id}});
    expect(board.current().edges).toHaveLength(4);
    fireEvent.click(screen.getByRole('button',{name:'撤销',exact:true}));
    expect(board.current().edges).toEqual(edges);
    expect(streamGeneration).not.toHaveBeenCalled();
  });

  it('drags one selected output port to connect the whole selection to a video', () => {
    const image={...newNode('image',{x:0,y:0}),title:'批量图片',src:'/image.png'};
    const audio={...newNode('audio',{x:0,y:300}),src:'/voice.wav'};
    const target={...newNode('video',{x:500,y:0}),title:'目标视频',generator:true};
    const initial={...newDocument(),nodes:[image,audio,target],view:{x:0,y:0,zoom:1}};
    const board=mount(initial);
    fireEvent.keyDown(window,{key:'a',ctrlKey:true});
    fireEvent.pointerDown(screen.getByRole('button',{name:'从 批量图片 连接'}),{button:0,pointerId:1,clientX:image.width,clientY:image.height/2});
    const surface=screen.getByLabelText('无限画布编辑区');
    fireEvent.pointerMove(surface,{pointerId:1,clientX:target.x,clientY:target.height/2});
    fireEvent.pointerUp(surface,{pointerId:1,clientX:target.x,clientY:target.height/2});
    expect(board.current().edges.map(e=>[e.from,e.to])).toEqual([[image.id,target.id],[audio.id,target.id]]);
    expect(streamGeneration).not.toHaveBeenCalled();
  });
});
