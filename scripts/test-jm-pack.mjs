import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
const code=String.raw`
import ast, os, re, json, tempfile, zipfile, time
from pathlib import Path
source=Path('plugins/python/jm.py').read_text(encoding='utf-8')
tree=ast.parse(source)
needed={'find_rar','_pack_once','_cmd_pack','cmd_pack','parse_pack_args','split_file'}
body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in needed or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='LAYERED_PACK_HELP' for t in n.targets)]
ns={'os':os,'re':re,'json':json,'Path':Path}
exec(compile(ast.Module(body=body,type_ignores=[]),'<offline jm>','exec'),ns)
assert ns['parse_pack_args']('加密','123456 60')==('123456','60',True)
assert ns['parse_pack_args']('123456','')==('123456','',False)
assert ns['parse_pack_args']('普通','123456 rar')==('123456','rar',False)
assert ns['parse_pack_args']('加密','')==('','',True)
assert '不能同时' in ns['cmd_pack']('加密','普通')
assert '固定' in ns['cmd_pack']('123456','加密 zip')
with tempfile.TemporaryDirectory(prefix='jm-pack-') as temp:
 root=Path(temp);download=root/'downloads';download.mkdir();album=download/'123456 title.v1';album.mkdir();(album/'test.txt').write_text('offline original')
 ns['download_dir']=lambda:download;ns['state_dir']=lambda:root/'state';ns['_plugin_settings']=lambda:(300,False);ns['_archive_prefs']=lambda:('zip',2,'fake seven');ns['find_rar']=lambda:'fake rar'
 original=ns['_pack_once'];calls=[]
 def pack(src,out,fmt,seven,timeout_seconds=540):
  calls.append((fmt,src.name))
  if fmt=='zip':return original(src,out,fmt,'',timeout_seconds)
  assert src.suffix=='', '上一层必须去掉后缀再装入下一层'
  with zipfile.ZipFile(out,'w') as z:z.write(src,src.name)
 ns['_pack_once']=pack
 def payload(result):
  assert result.startswith('@@FILE@@'),result
  return json.loads(result[len('@@FILE@@'):])
 normal=payload(ns['cmd_pack']('123456',''));assert normal['name'].endswith('.2.zip');assert [x[0] for x in calls]==['zip','zip'];calls.clear()
 encrypted=payload(ns['cmd_pack']('123456','加密 60'))
 assert [x[0] for x in calls]==['zip','7z','rar'];assert Path(encrypted['name']).suffix=='';assert encrypted['recall_seconds']==60
 assert '使用说明' in encrypted['text'] and '.rar' in encrypted['text'] and '.7z' in encrypted['text'] and '.zip' in encrypted['text'] and '不设密码' in encrypted['text']
 current=Path(encrypted['path'])
 for stage in range(3):
  folder=root/('restore'+str(stage));folder.mkdir()
  with zipfile.ZipFile(current) as z:z.extractall(folder)
  current=next(folder.iterdir())
  if stage<2:assert current.suffix==''
 assert (current/'test.txt').read_text()=='offline original'
 calls.clear();cached=payload(ns['cmd_pack']('加密','123456'));assert not calls and '使用说明' in cached['text']
 ns['find_rar']=lambda:''
 failure=ns['cmd_pack']('123456','加密');assert not failure.startswith('@@FILE@@') and 'RAR_PATH' in failure and '使用说明' in failure
 ns['find_rar']=lambda:'fake rar'
 (album/'new.txt').write_text('changed');os.utime(album/'new.txt',(time.time()+2,time.time()+2))
 def fail(src,out,fmt,seven,timeout_seconds=540):
  if fmt=='rar':out.write_bytes(b'partial');raise RuntimeError('RAR failed')
  return pack(src,out,fmt,seven,timeout_seconds)
 ns['_pack_once']=fail
 failure=ns['cmd_pack']('123456','加密');assert not failure.startswith('@@FILE@@') and 'RAR failed' in failure and '使用说明' in failure
 assert not list((root/'state'/'exports'/'layered-v1'/album.name).glob('*.rar')),'失败暂存文件须清理'
print('JM modes passed: default normal, flexible mode/ID order, ZIP-7z-RAR sequence, extension stripping, reverse recovery, cached instructions, missing tools and failed staging. No network/QQ calls; upper layers simulated.')
`
const r=spawnSync(process.env.PYTHON_PATH||'python',['-X','utf8','-c',code],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,timeout:15000})
assert.ifError(r.error);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);console.log(r.stdout.trim())
