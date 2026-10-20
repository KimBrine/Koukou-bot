import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 控制台页面已拆成 html + app.js + ui.css；测试统一读合并后的源码。 */
export function readUiSource() {
  const base = new URL('../src/admin/', import.meta.url)
  let out = ''
  for (const file of ['ui.html', 'stickerUpload.js', 'app.js', 'ui.css']) {
    const target = new URL(file, base)
    if (existsSync(fileURLToPath(target))) out += readFileSync(target, 'utf8') + '\n'
  }
  return out
}

export function readUiScript() {
  return readFileSync(new URL('../src/admin/app.js', import.meta.url), 'utf8')
}
