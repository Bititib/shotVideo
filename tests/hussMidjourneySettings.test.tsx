// @vitest-environment jsdom
import React, {useState} from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {HussMidjourneySettings} from '../client/src/components/HussMidjourneySettings';
import {hussMjOptions,type HussMjOptions} from '../shared/hussMidjourney';
afterEach(cleanup);
it('edits style controls without putting presentation labels or stale prompt into request fields',()=>{
 function View(){const [value,setValue]=useState<HussMjOptions>({});return <><HussMidjourneySettings mjOptions={value} setMjOptions={setValue}/><output data-testid="values">{JSON.stringify(hussMjOptions(value))}</output></>;}
 render(<View/>);
 fireEvent.change(screen.getByLabelText('渲染模式'),{target:{value:'raw'}});
 fireEvent.change(screen.getByLabelText('风格化强度'),{target:{value:'250'}});
 fireEvent.change(screen.getByLabelText('随机种子'),{target:{value:'0'}});
 fireEvent.change(screen.getByLabelText('风格参考图直链'),{target:{value:'https://media.test/style.jpg'}});
 fireEvent.click(screen.getByLabelText('无缝平铺'));
 expect(JSON.parse(screen.getByTestId('values').textContent!)).toMatchObject({style:'raw',stylize:'250',seed:0,tile:true,sref:'https://media.test/style.jpg'});
 expect(hussMjOptions({prompt:'old prompt',model:'old',n:4,stylize:'500'})).toEqual({stylize:'500'});
});
