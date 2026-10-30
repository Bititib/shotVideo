"""Stage a validated plugin ZIP and publish pointer locally; does not deploy the website."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument('archive',type=Path)
parser.add_argument('--notes',default='插件功能更新与问题修复。')
args=parser.parse_args()
plugin='video_plugin_site_api'
files={'main.py','updater.py','info.json','ui/index.html','使用说明.txt'}
raw=args.archive.read_bytes()
assert 0<len(raw)<=8*1024*1024,'Archive too large'
with zipfile.ZipFile(args.archive) as z:
    assert len(z.infolist())==len(files) and set(z.namelist())=={plugin+'/'+f for f in files},'Only clean program files may be published'
    assert all(i.file_size<=4*1024*1024 for i in z.infolist()),'File too large'
    assert z.testzip() is None,'Archive corrupt'
    meta=json.loads(z.read(plugin+'/info.json'))
    version=meta['version']
    assert re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)',version),'Invalid version'
    assert meta['type']=='video' and meta['api_version']==2,'Host API mismatch'
    for file in ('main.py','updater.py'):compile(z.read(plugin+'/'+file),file,'exec')
root=Path(__file__).resolve().parents[1]/'plugin-releases'/plugin
root.mkdir(parents=True,exist_ok=True)
target=root/f'lingxu-video-{version}.zip'
assert not target.exists() or target.read_bytes()==raw,'Version already exists with different content; bump version'
pointer=root/'latest.json'
if pointer.exists():
    old=json.loads(pointer.read_text('utf-8'))['version']
    assert tuple(map(int,version.split('.')))>=tuple(map(int,old.split('.'))),'Do not downgrade latest'
manifest={'schema_version':1,'plugin_id':plugin,'version':version,'min_updater':1,
          'archive':f'/plugin-updates/{plugin}/{target.name}','size':len(raw),
          'sha256':hashlib.sha256(raw).hexdigest(),'notes':args.notes}
# ZIP first, pointer last. The website deployment must use the same ordering.
temp=target.with_suffix('.zip.tmp');temp.write_bytes(raw);temp.replace(target)
temp=pointer.with_suffix('.json.tmp');temp.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(pointer)
print(f'Staged {version}; deploy website and verify its manifest and archive before announcing the release.')
