# 测试脚本分类

> 自动生成于 2026-10-20。

## 进离线套件（npm test / scripts/test-offline.mjs）

共 47 个：只读、不联网、不发 QQ 消息、不调用付费接口。
新增测试请加进 `test-offline.mjs` 的 allowlist。

## 未进套件（探针/实验，可能联网或发真实消息）

共 56 个：

- `test-admin-api.mjs`
- `test-array-face-e2e.mjs`
- `test-baidu-search.mjs`
- `test-bigcount.mjs`
- `test-count.mjs`
- `test-daily-ping-flow.mjs`
- `test-daily-ping-schedule.mjs`
- `test-daily-ping.mjs`
- `test-dashscope.mjs`
- `test-deepseek-vision.mjs`
- `test-deepseek.mjs`
- `test-env-and-auth.mjs`
- `test-face-convert.mjs`
- `test-face-e2e.mjs`
- `test-face.mjs`
- `test-flash-model.mjs`
- `test-flash-shape.mjs`
- `test-friend-history.mjs`
- `test-getmsg.mjs`
- `test-humanize.mjs`
- `test-id-check.mjs`
- `test-image-download.mjs`
- `test-image-note.mjs`
- `test-live-length.mjs`
- `test-models.mjs`
- `test-multiline-send.mjs`
- `test-offline.mjs`
- `test-paging.mjs`
- `test-paging2.mjs`
- `test-poke.mjs`
- `test-proactive.mjs`
- `test-quote-structure.mjs`
- `test-qwen37flash-vision.mjs`
- `test-reply-parse.mjs`
- `test-reply-policy.mjs`
- `test-reply-shape.mjs`
- `test-search-loop.mjs`
- `test-send-at.mjs`
- `test-short-tokens.mjs`
- `test-shorten.mjs`
- `test-sticker-repro.mjs`
- `test-summary-budget.mjs`
- `test-summary-cmd.mjs`
- `test-summary-models.mjs`
- `test-summary.mjs`
- `test-target-watch.mjs`
- `test-text-to-segments.mjs`
- `test-time-window.mjs`
- `test-tone.mjs`
- `test-tools.mjs`
- `test-vision-history.mjs`
- `test-vision-live.mjs`
- `test-vision-note.mjs`
- `test-vision-provider.mjs`
- `test-vision-repro.mjs`
- `test-vision-two-step.mjs`

这些脚本不要随手批量跑；需要时先读脚本确认副作用。
