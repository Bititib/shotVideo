// @vitest-environment jsdom
import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import AssetPicker from '../client/src/canvas/AssetPicker';
import {newDocument, newNode} from '../client/src/canvas/model';

vi.mock('../client/src/canvas/AssetBrowser', () => ({default: () => <div>生成记录</div>}));
afterEach(() => {cleanup(); vi.clearAllMocks();});

it('only builds visible canvas candidates and reuses eligibility while searching', () => {
  let reads = 0;
  const node = {...newNode('image',{x:0,y:0}),title:'角色图片',get src() {reads++; return '/actor.png';}};
  const document = {...newDocument(),nodes:[node]};
  const onChoose = vi.fn();
  render(<AssetPicker document={document} projects={[document]} mode="add" onClose={vi.fn()} onChoose={onChoose} onFiles={vi.fn()}/>);
  expect(screen.getByText('生成记录')).toBeTruthy();
  expect(reads).toBe(0);
  fireEvent.click(screen.getByRole('button',{name:'本地上传',exact:true}));
  expect(reads).toBe(0);
  fireEvent.click(screen.getByRole('button',{name:'本项目素材',exact:true}));
  expect(screen.getByText(node.title)).toBeTruthy();
  const inspected = reads; expect(inspected).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText('搜索可引用素材'),{target:{value:'不存在'}});
  expect(screen.queryByText(node.title)).toBeNull();
  fireEvent.change(screen.getByLabelText('搜索可引用素材'),{target:{value:'角色'}});
  expect(reads).toBe(inspected);
  fireEvent.click(screen.getByRole('button',{name:'加入画布',exact:true}));
  expect(onChoose).toHaveBeenCalledWith([expect.objectContaining({id:node.id,src:'/actor.png',origin:{projectId:document.id,nodeId:node.id,title:document.title}})]);
});

it('refreshes candidates after a source becomes ready and after changing target kind', () => {
  const image = {...newNode('image',{x:0,y:0}),title:'候选图片'};
  const video = {...newNode('video',{x:0,y:0}),title:'候选视频',src:'/ready.mp4'};
  const document = {...newDocument(),nodes:[image,video]};
  const target = newNode('image',{x:0,y:0});
  const props = {document,projects:[document],target,mode:'fill' as const,onClose:vi.fn(),onChoose:vi.fn(),onFiles:vi.fn()};
  const board = render(<AssetPicker {...props}/>);
  expect(screen.queryByText(image.title)).toBeNull();
  expect(screen.queryByText(video.title)).toBeNull();
  const ready = {...document,nodes:[{...image,src:'/ready.png'},video]};
  board.rerender(<AssetPicker {...props} document={ready}/>);
  expect(screen.getByText(image.title)).toBeTruthy();
  board.rerender(<AssetPicker {...props} document={ready} target={{...target,kind:'video'}}/>);
  expect(screen.queryByText(image.title)).toBeNull();
  expect(screen.getByText(video.title)).toBeTruthy();
});
