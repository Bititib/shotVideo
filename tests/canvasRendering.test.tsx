// @vitest-environment jsdom
import React from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, render} from '@testing-library/react';
import CanvasConnections from '../client/src/canvas/CanvasConnections';
import {newNode} from '../client/src/canvas/model';
afterEach(() => {cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('keeps curves crossing the viewport even with both endpoints offscreen, and culls distant curves', () => {
  const nodes=[{...newNode('image',{x:-1000,y:100}),id:'a'},{...newNode('video',{x:1200,y:100}),id:'b'},
    {...newNode('image',{x:2000,y:2000}),id:'c'},{...newNode('video',{x:2400,y:2000}),id:'d'}];
  const edges=[{id:'across',from:'a',to:'b'},{id:'back',from:'b',to:'a'},{id:'far',from:'c',to:'d'},{id:'invalid',from:'missing',to:'a'}];
  const props={nodes,edges,view:{x:0,y:0,zoom:1},viewport:{width:800,height:600}};
  const board=render(<svg><CanvasConnections {...props}/></svg>);
  const curves=board.container.querySelectorAll('path');
  expect(curves).toHaveLength(2);
  expect(curves[0].getAttribute('d')).toContain('M-700,235');
  expect(curves[1].getAttribute('d')).toContain('M1500,235');
  board.rerender(<svg><CanvasConnections {...props} view={{x:-2000,y:-1900,zoom:1}}/></svg>);
  expect(board.container.querySelectorAll('path')).toHaveLength(1);
  expect(board.container.querySelector('path')?.getAttribute('d')).toContain('M2300,2135');
  board.rerender(<svg><CanvasConnections {...props} visible={false}/></svg>);
  expect(board.container.querySelector('path')).toBeNull();
});

it('draws dense connections at the viewport scale, clears hidden links and restores dashes on zoom-in', () => {
  const context={setTransform:vi.fn(),clearRect:vi.fn(),setLineDash:vi.fn(),beginPath:vi.fn(),moveTo:vi.fn(),bezierCurveTo:vi.fn(),stroke:vi.fn()};
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(context as any);
  vi.stubGlobal('devicePixelRatio',2);
  const a={...newNode('image',{x:0,y:0}),id:'a'},b={...newNode('video',{x:400,y:0}),id:'b'};
  const props={nodes:[a,b],edges:Array.from({length:301},(_,i)=>({id:String(i),from:a.id,to:b.id})),view:{x:20,y:30,zoom:.3},viewport:{width:800,height:600}};
  const board=render(<CanvasConnections {...props}/>);
  const canvas=board.container.querySelector('canvas')!;
  expect(canvas.width).toBe(1600);expect(canvas.height).toBe(1200);
  expect(context.setTransform).toHaveBeenLastCalledWith(.6,0,0,.6,40,60);
  expect(context.bezierCurveTo).toHaveBeenCalledWith(380,135,320,135,400,135);
  expect(context.setLineDash).toHaveBeenLastCalledWith([]);
  board.rerender(<CanvasConnections {...props} view={{x:20,y:30,zoom:1}}/>);
  expect(context.setLineDash).toHaveBeenLastCalledWith([5,4]);
  context.stroke.mockClear();
  board.rerender(<CanvasConnections {...props} visible={false}/>);
  expect(context.clearRect).toHaveBeenLastCalledWith(0,0,1600,1200);
  expect(context.stroke).not.toHaveBeenCalled();
});

it('retains visible connections through SVG if a dense canvas context is unavailable', () => {
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
  const a={...newNode('image',{x:0,y:0}),id:'a'},b={...newNode('video',{x:400,y:0}),id:'b'};
  const board=render(<CanvasConnections nodes={[a,b]} edges={Array.from({length:301},(_,i)=>({id:String(i),from:a.id,to:b.id}))} view={{x:0,y:0,zoom:1}} viewport={{width:800,height:600}}/>);
  expect(board.container.querySelector('canvas')).toBeNull();
  expect(board.container.querySelectorAll('path')).toHaveLength(301);
});
