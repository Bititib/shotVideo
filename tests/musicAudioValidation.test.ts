import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateMusicAudioFile } from '../server/services/musicAudioValidation.js';

it('probes and fully decodes real audio; rejects empty files, fake ID3 and damaged frame data',async()=>{
  const fixture=await fs.readFile(new URL('./fixtures/music-valid.mp3',import.meta.url));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'music-validate-'));
  const file=path.join(dir,'song.mp3');
  try {
    await fs.writeFile(file,fixture);
    const valid=await validateMusicAudioFile(file);
    expect(valid).toMatchObject({size:fixture.length,codec:'mp3',channels:1});expect(valid.duration).toBeGreaterThan(0);
    const damaged=Buffer.from(fixture);damaged.fill(255,800,1200);
    await fs.writeFile(file,damaged);await expect(validateMusicAudioFile(file)).rejects.toThrow('完整解码');
    for(const data of [Buffer.alloc(0),Buffer.from('ID3 not audio'),fixture.subarray(0,60)]) {
      await fs.writeFile(file,data);await expect(validateMusicAudioFile(file)).rejects.toThrow('音乐成品校验失败');
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
