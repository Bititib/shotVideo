// @vitest-environment jsdom
import React, {useState} from 'react';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import ReferencePrompt from '../client/src/canvas/ReferencePrompt';
import {newDocument,parseDocument} from '../client/src/canvas/model';
const longText=Array.from({length:600},(_,i)=>`镜头${i}：人物沿着河岸行走，远处山峦叠嶂，镜头缓缓推进，保持人物与场景一致。\n`).join('');
function Editor(){const [value,setValue]=useState(longText);return <><button>背景操作</button><ReferencePrompt value={value} onChange={setValue} placeholder="长文输入" references={[]} bindings={{}} kind="video" onPick={()=>undefined}/></>;}
beforeEach(()=>localStorage.clear());afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('edits over 20,000 characters without truncation, and preserves the same textarea across expand/collapse',()=>{
  render(<Editor/>);const input=screen.getByPlaceholderText('长文输入') as HTMLTextAreaElement;
  expect(input.value.length).toBeGreaterThan(20000);input.setSelectionRange(12345,12350);input.scrollTop=600;
  fireEvent.click(screen.getByRole('button',{name:'展开编辑'}));
  expect(screen.getByRole('dialog',{name:'长文提示词编辑器'})).toBeTruthy();expect(screen.getByPlaceholderText('长文输入')).toBe(input);
  expect(input.selectionStart).toBe(12345);expect(input.scrollTop).toBe(600);
  const updated=longText+'补充分镜结尾';fireEvent.change(input,{target:{value:updated}});
  fireEvent.click(screen.getByRole('button',{name:'完成编辑'}));expect(screen.queryByRole('dialog')).toBeNull();expect(input.value).toBe(updated);
  fireEvent.click(screen.getByRole('button',{name:'展开编辑'}));expect(screen.getByPlaceholderText('长文输入')).toBe(input);expect(input.value).toBe(updated);
});
it('persists font size and keeps background controls inert only while expanded',()=>{
  const view=render(<Editor/>);const background=screen.getByRole('button',{name:'背景操作'});
  fireEvent.click(screen.getByRole('button',{name:'展开编辑'}));expect(background.inert).toBe(true);
  fireEvent.change(screen.getByLabelText('提示词字号'),{target:{value:'20'}});expect(localStorage.getItem('canvas-prompt-font-size')).toBe('20');
  fireEvent.keyDown(screen.getByPlaceholderText('长文输入'),{key:'Escape'});expect(background.inert).not.toBe(true);expect(screen.queryByRole('dialog')).toBeNull();
  view.unmount();render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:'展开编辑'}));expect((screen.getByLabelText('提示词字号') as HTMLSelectElement).value).toBe('20');
});
it('searches and cycles through long text without changing it',()=>{
  render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:'展开编辑'}));
  const input=screen.getByPlaceholderText('长文输入') as HTMLTextAreaElement;
  fireEvent.change(screen.getByLabelText('查找提示词内容'),{target:{value:'镜头599'}});fireEvent.click(screen.getByRole('button',{name:'查找下一处'}));
  expect(input.selectionStart).toBe(longText.indexOf('镜头599'));expect(input.value).toBe(longText);
  fireEvent.click(screen.getByRole('button',{name:'查找下一处'}));expect(input.selectionStart).toBe(longText.indexOf('镜头599'));
  fireEvent.change(screen.getByLabelText('查找提示词内容'),{target:{value:'不存在的镜头'}});fireEvent.click(screen.getByRole('button',{name:'查找下一处'}));
  expect(screen.getByRole('status').textContent).toBe('未找到匹配内容');expect(input.value).toBe(longText);
});
it('retains a long draft through canvas serialization and restoration',()=>{
  const doc={...newDocument(),drafts:{node:{kind:'video' as const,prompt:longText,model:'test',ratio:'16:9',resolution:'720p',seconds:5}}};
  expect(parseDocument(JSON.parse(JSON.stringify(doc))).drafts?.node.prompt).toBe(longText);
});
it('closes the mention picker before closing the long editor on Escape',()=>{
  render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:'展开编辑'}));
  const input=screen.getByPlaceholderText('长文输入');fireEvent.change(input,{target:{value:longText+'@',selectionStart:longText.length+1}});
  expect(screen.getByRole('listbox')).toBeTruthy();fireEvent.keyDown(input,{key:'Escape'});
  expect(screen.queryByRole('listbox')).toBeNull();expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.keyDown(input,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();
});
