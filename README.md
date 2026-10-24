<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

## 模型与渠道开发准则

新增模型、渠道或修改提交、查询、恢复和计费逻辑前，必须遵守 [模型与渠道接入准则](docs/model-channel-integration-standard.md)，并填写 [接入验收记录](docs/model-channel-integration-template.md)。仓库代理开发要求见 [AGENTS.md](AGENTS.md)。

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/780544a4-ac97-4dd5-aa02-df0863dc58d1

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
