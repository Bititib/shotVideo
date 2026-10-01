# 声音克隆

语音工作室支持上传 WAV、MP3、OGG 参考音频（最大 10MB，建议 10～30 秒）、命名、选择和删除个人音色。音色完整资源名保存在 `data/cloned_voices.json`，跟随现有 Docker data 挂载持久化，也包含在备份脚本中。该文件只供服务端读取，记录按用户和上游地址隔离；请勿手动编辑或提交到 Git。

服务按提供的接口协议调用 `POST /v1beta/voices` 和 `DELETE /v1beta/voices/{id}`，鉴权使用现有 Gemini 渠道或环境变量密钥。预置音色仍来自实测的 `/v1/voices`。合成将完整的 `voices/...` 资源名原样传给 voiceName。只有明确的失效音色错误才会自动重试预置音色，并向用户提示实际使用的声音；模型不存在、鉴权错误或超时不会触发替换。

网站接口均需要登录：

- `GET /api/analysis/cloned-voices`：当前用户保存的克隆音色与上游预置音色。
- `POST /api/analysis/cloned-voices`：multipart 字段 audio、displayName。
- `DELETE /api/analysis/cloned-voices`：JSON 字段 voiceId（完整资源名）。

2026-10-01 验证：本地模拟接口的服务、页面和计费测试通过。当前配置的实际代理 `GET /v1beta/voices` 返回 404，尚未取得真实克隆 ID，不能据此宣称上游支持声音克隆。需要代理提供方确认创建接口可用，并用已获授权的参考音频完成创建、合成和删除验收。返回非 ACTIVE 状态的记录会保存但不能选择；当前刷新读取本地记录，不会轮询上游异步创建状态。

JSON 存储面向当前单实例部署；多进程或多实例部署前需迁移到数据库或增加跨进程锁。
