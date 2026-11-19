<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

## Codex 渠道接入编码准则

Codex 接入模型、渠道或修改提交、查询、恢复和计费代码时，必须执行 [编码准则](docs/model-channel-integration-standard.md)。指令入口为 [AGENTS.md](AGENTS.md)；[开发记录模板](docs/model-channel-integration-template.md) 由 Codex 按需填写，不要求用户执行验收流程。

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/780544a4-ac97-4dd5-aa02-df0863dc58d1

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 大模型对话

登录后，从工作台左侧「大模型对话」进入 `/app/chat`。模型列表使用已启用、已审核、当前账号可用的文本模型。对话历史随账号保存，同一会话内的后续消息会带上已完成的问答。

对话沿用 `/v1/chat/completions` 的上游请求与 Token 定价。网页版使用登录账号的余额，发出前保存请求编号及预扣记录，按上游用量结算。浏览器断开后服务端继续接收原回复，重新进入会话即可读取进度。服务进程中断后，已预扣且无法确认结果的请求进入待核实，保留原账单供管理员核对。

输入栏的「＋」可添加 PNG、JPEG、WebP、PDF 和 Word `.docx`，每轮最多 3 个，每个最多 4 MB。看图仅开放给同时配置了文本和图片分析权限、且具有已支持图片输入线路的模型。图片通过已核对的 Chat Completions `image_url` 内容块发送，PDF 和 Word 提取文本后随对话发送。扫描件需要先转成图片，Word 旧版 `.doc` 需另存为 `.docx`。对话后续消息会携带已完成轮次中的附件内容。
