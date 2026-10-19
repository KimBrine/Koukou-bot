import { STICKER_MAX_BYTES } from './stickers.js'
import { STICKER_SCENES } from './stickers.js'

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/**
 * 从群聊里的图片/表情包自动学习：
 * - 只学白名单群里别人发的图，不学机器人自己发的；
 * - 每小时有次数上限，避免刷屏式采集和 API 花销；
 * - 有视觉模型时自动起名 + 打关键词/语境，没有就用占位名（之后可手动改）。
 */
export function createStickerLearner({ config, logger, onebot, stickers, visionLLM, fetchImpl = fetch, now = () => Date.now() }) {
  const HOUR = 3600000
  let windowStart = 0
  let used = 0

  function takeSlot() {
    const t = now()
    if (t - windowStart >= HOUR) { windowStart = t; used = 0 }
    if (used >= Math.max(0, config.stickerLearnPerHour || 0)) return false
    used += 1
    return true
  }

  async function resolveImage(image) {
    let url = String(image?.url || '').trim()
    if (!url && image?.file && onebot?.api) {
      try {
        const res = await onebot.api('get_image', { file: String(image.file) })
        url = String(res?.data?.url || res?.url || '').trim()
      } catch (err) {
        logger?.warn?.(`[表情包学习] 取图片地址失败：${err.message}`)
        return null
      }
    }
    if (!url) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetchImpl(url, { signal: controller.signal })
      if (!res.ok) return null
      const type = String(res.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!MIME_EXT[type]) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1024 || buf.length > STICKER_MAX_BYTES) return null
      return `data:${type};base64,${buf.toString('base64')}`
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  function parseTag(raw) {
    const text = String(raw || '')
    const m = /\{[\s\S]*\}/.exec(text)
    if (m) {
      try {
        const j = JSON.parse(m[0])
        const scenes = Array.isArray(j.scenes) ? j.scenes.filter((s) => STICKER_SCENES.some((x) => x.id === s)) : []
        return {
          name: String(j.name || '').trim().slice(0, 20),
          keywords: Array.isArray(j.keywords) ? j.keywords.join(' ') : String(j.keywords || ''),
          scenes,
        }
      } catch { /* 落到下面的兜底 */ }
    }
    return null
  }

  async function describe(dataUrl) {
    if (!visionLLM?.describeImages) return null
    const sceneIds = STICKER_SCENES.map((s) => s.id).join(', ')
    const prompt = [
      '你在给聊天用的表情包打标签，只输出一行 JSON，不要解释。',
      '格式：{"name":"4到8个字的简短名称","keywords":["关键词1","关键词2","关键词3"],"scenes":["场景id"]}',
      `scenes 只能从这个列表里选 1~3 个：${sceneIds}`,
      'name 要像群友随口起的绰号（例如：竖大拇指、猫猫震惊、摆烂躺平），不要"图片描述"式长句。',
      'keywords 是别人可能用来指代它的词，2~5 个，不要标点。',
    ].join('\n')
    try {
      const out = await visionLLM.describeImages(prompt, '', [{ type: 'image_url', image_url: { url: dataUrl } }])
      return parseTag(out)
    } catch (err) {
      logger?.warn?.(`[表情包学习] 识别失败：${err.message}`)
      return null
    }
  }

  /** 处理一条群里收到的图片消息；返回 learnt 条目或 null */
  async function learnFromMessage({ images, groupId, senderName, text } = {}) {
    if (!config.stickerLearnEnabled || !stickers) return null
    if (!Array.isArray(images) || images.length === 0) return null
    if (!stickers || takeSlot() === false) return null
    const dataUrl = await resolveImage(images[0])
    if (!dataUrl) return null
    const tag = await describe(dataUrl)
    const out = stickers.add({
      name: tag?.name || `群友表情${stickers.count() + 1}`,
      keywords: tag?.keywords || '',
      scenes: tag?.scenes || [],
      dataUrl,
      origin: 'learned',
      source: `群${groupId || ''} ${senderName || ''} ${String(text || '').slice(0, 20)}`.trim(),
    })
    if (out?.item) {
      logger?.info?.(`[表情包学习] 从群里学会「${out.item.name}」${out.duplicated ? '（已存在）' : ''}`)
      return out.item
    }
    return null
  }

  return { learnFromMessage, stats: () => ({ used, windowStart }) }
}
