/**
 * 点歌：解析"想听/点歌/来一首"这类请求，搜网易云拿第一首，供上层发音乐名片。
 */
const SONG_PREFIX = /^(?:\/(?:点歌|music|song)\s*|(?:帮我)?(?:点歌|点一首|来一首|来首|放一首|放首|唱一首|唱首|想听|要听|想点)\s*[:：]?\s*)/i

export function parseSongRequest(text, quotedText) {
  const raw = String(text || '').replace(/\[图片\]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  const quoted = String(quotedText || '').replace(/\s+/g, ' ').trim()
  // "我想听这个，发给我" —— 用被引用的那条消息当歌名
  if (/^(?:我)?(?:想听|要听|听)(?:这个|这首)(?:[，, ]*(?:发给我|放给我))?[。！!~～]?\s*$/.test(raw) && quoted) return quoted.slice(0, 40)
  let q = ''
  const m = raw.match(SONG_PREFIX)
  if (m) q = raw.slice(m[0].length).trim()
  else {
    const m2 = raw.match(/(?:想听|要听|想点|点歌)\s*[:：]?\s*(.+)$/)
    if (m2) q = m2[1].trim()
  }
  q = q.replace(/^(?:一首|首|一下|这个|这首)/, '').replace(/^[《「『\"']+|[》」』\"']+$/g, '').replace(/[。！？!?，,～~\s]+$/, '').trim()
  if (!q || q.length < 1 || q.length > 40) return ''
  if (/^(?:你|您)/.test(q)) return ''
  return q
}

export async function searchSong(query, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim().slice(0, 60)
  if (!q) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl('https://music.163.com/api/search/get/web?s=' + encodeURIComponent(q) + '&type=1&limit=5', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://music.163.com/' },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    const songs = data && data.result && Array.isArray(data.result.songs) ? data.result.songs : []
    const song = songs[0]
    if (!song) return null
    const artists = (song.artists || song.ar || []).map(function (a) { return a && a.name }).filter(Boolean).join('/')
    return { id: String(song.id), name: String(song.name || q), artist: artists || '', url: 'https://music.163.com/song?id=' + song.id }
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
}
