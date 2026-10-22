// 离线：计算器插件的全角/中文符号归一化（需要本机有 python）
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.PYTHON_PATH || 'python'
const script = path.join(root, 'plugins', 'python', 'calc.py')

const run = (expr) => {
  const r = spawnSync(python, ['-X', 'utf8', script, expr], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    timeout: 15000,
  })
  if (r.error) throw r.error
  return `${r.stdout || ''}${r.stderr || ''}`.trim()
}

let pass = 0
const check = (name, expr, expect) => {
  const out = run(expr)
  assert.equal(out, expect, `${name}：${expr} → ${JSON.stringify(out)}`)
  pass++
  console.log('PASS', name, '→', out)
}

try {
  spawnSync(python, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10000 })
} catch (err) {
  console.log('python 不可用，跳过计算器检查：' + err.message)
  process.exit(0)
}

check('全角数字与加号', '１２３＋４５', '168')
check('全角括号与乘号', '（１＋２）×３', '9')
check('中文“除以”', '10除以4', '2.5')
check('中文“乘”', '6乘7', '42')
check('中文“的平方”', '3的平方', '9')
check('全角参数里的函数调用', 'sqrt(９)', '3')
check('中文逗号分隔参数', 'min（１，２）', '1')
check('除号 ÷', '（２＋３）÷２', '2.5')
check('全角空格', '１＋２　', '3')
check('全角字母函数名', 'ｓｑｒｔ（１６）', '4')
assert.match(run('1÷0'), /不能除以 0/)
pass++
console.log('PASS 除以 0 给中文提示')
assert.match(run('９**９**９'), /指数太大/)
pass++
console.log('PASS 超大指数被拦下（不会挂死）')
console.log(`py calc checks passed: ${pass}`)
