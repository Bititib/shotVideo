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
