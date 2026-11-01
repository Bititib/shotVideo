// @vitest-environment jsdom
import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import HssSourceSwitch from '../client/src/components/HssSourceSwitch';
import {adminApi} from '../client/src/api/admin';
vi.mock('../client/src/api/admin',()=>({adminApi:{getModelSpecifications:vi.fn(),switchHssSource:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('switches immediately and displays only the confirmed saved source',async()=>{
 vi.mocked(adminApi.getModelSpecifications).mockResolvedValue([{modelId:'hss-2.5-301010',routes:[{upstreamModel:'bb-2.5-301010-渠道A'}]}]);
 vi.mocked(adminApi.switchHssSource).mockResolvedValue({routes:[{upstreamModel:'hss-2.5-301010-渠道B'}]});
 render(<HssSourceSwitch/>);
 await screen.findByRole('button',{name:'新渠道A · 当前'});
 fireEvent.click(screen.getByRole('button',{name:'原渠道B'}));
 await screen.findByRole('button',{name:'原渠道B · 当前'});
 expect(adminApi.switchHssSource).toHaveBeenCalledExactlyOnceWith('B');
 vi.mocked(adminApi.switchHssSource).mockRejectedValue(new Error('保存失败'));
 fireEvent.click(screen.getByRole('button',{name:'新渠道A'}));
 await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe('保存失败'));
 expect(screen.getByRole('button',{name:'原渠道B · 当前'}).getAttribute('aria-pressed')).toBe('true');
});
