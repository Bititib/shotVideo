# 灵序视频插件 1.1.1：现有模型参数审计

2026-10-30，基线 a1f9d4e。核对 video.zhubo.asia 当前启用的型号；按用户后续要求，本次特殊参数适配排除巨轮，范围为其余 12 个型号。依据实际接入渠道，未用其他供应商同名模型的字段替代。没有提交付费生成。

| 当前型号 | 发布给插件的额外参数 | 上游传递 |
| --- | --- | --- |
| MiniMax-H3、sd2.5-933 | function_mode：first_last_frames / omni_reference | HM 原字段；保持原 nova / DDLONG 路由 |
| seedance_v2.0-933 | function_mode：multi_frame / omni_reference | HM 原字段；保持 default 路由 |
| Veo 3.1、Veo 3.1 Lite（FunAI） | audio：boolean | 原字段，可传 false；未填则省略 |
| Gemini Omni Flash（FunAI） | reference_mode：frame / style / element | 分别将普通参考图传入 input_reference / style_references / element_references |
| 4 个现有 WAN 型号 | prompt_extend：boolean | 保持 parameters.prompt_extend |
| Grok Imagine Video 1.5（snumom） | 当前文档没有额外生成开关 | 不套用其他 Grok 渠道字段 |
| hss-2.5-301010（HUSS） | 当前契约没有额外生成开关 | 不添加统一契约不接受的字段 |

## 协议依据

- HM 当前公开页面内嵌的视频 API 文档：<https://openaivideo.top/>。共享字段 function_mode，模式专属素材不可混用；具体型号模式另与仓库的 HM_MINIMAX_H3_NOVA_INTEGRATION、HM_DEFAULT_V20_INTEGRATION、HM_DDLONG_REPLACEMENT 已核对记录交叉检查。face 与 channel 继续由原适配器控制，不把平台固定处理伪装成用户开关。
- FunAI 当前模型文档：<https://ztyunjuan.com/docs/#/models/veo-3.1>、<https://ztyunjuan.com/docs/#/models/veo-3.1-lite>、<https://ztyunjuan.com/docs/#/models/gemini-omni-flash>。实际读取其公开 model-data.js 与 app.js 的型号定义和参数表：两个 Veo 型号 supportsAudio=true；Omni 无音轨开关，reference_mode 为 frame/style/element，角色明确的素材字段优先。网站管理员配置的素材总量上限继续生效，不改写既有规格、售价或开关。
- snumom 型号专属示例：<https://snumom.com/docs/wan-3.0.html#grokex>。Grok 1.5 的字段表只有基础规格和图片参考，未列负面提示词、随机种子或音轨开关。
- HUSS：<https://www.huss.top/api-docs/unified-video.md>、<https://www.huss.top/api-docs/unified-capabilities.json>。统一契约不允许模型专用扩展字段。旧型号文档入口当前返回 404，结合既有 HSS 接入记录保留当前协议；没有擅自切换调用模式。
- 巨轮按用户要求排除本次适配，未修改其已有模型记录或生成参数。

## 实际调用链

- /v1/models 与 /api/video/models 继续统一使用 videoCapabilities。额外枚举中文标签放在 parameterEnumLabels 中，不污染旧版插件支持的 JSON Schema 子集；parameterNote 区分已核对无额外参数与资料不足。
- /v1/videos 和网站 /api/video/generate、/validate 在扣费前展开并校验 model_parameters。JSON 保留布尔值，multipart 的 model_parameters 为 JSON 字符串。
- HM 原生网站入口原先未保存 function_mode，现保存到订单 metadata，HM 队列从原快照取值；规格适配器原先强制混合素材，现尊重已校验的显式模式。API 原生队列沿用现有字段。
- FunAI 规格执行器保留 request.body，Veo 转发 audio；Omni 根据参考角色映射素材，不重复发送或截断。模式与图片数量不符、无图指定角色、多帧带视频等在生成前拒绝。
- 修复批量入口原先过滤掉 model_parameters 的问题：批量预检、持久化设置及 worker 保留同一份类型化参数，再交给网站入口校验与转发。未修改提交占用、受理判断、恢复、定价或退款规则。
- 插件 1.1.1 仅允许 boolean 类型的 audio 作为专属参数，仍禁止字符串/文件 audio 覆盖素材字段；按网站返回的中文标签显示枚举，按模型和账号隔离已存值。

## 交付与边界

1.1.0 更新器可以安装 1.1.1；配置、任务账本不在发行包内。网站部署后，用户从插件“检查更新”升级并重启字字动画。旧版 1.1.0 不支持专属 audio 开关，需要先升级；旧字段与已生成任务仍保留。

本次真实 HTTP 本地入口测试使用内存数据库、模拟上游；覆盖 HM 原生队列/规格路线、FunAI 网站/API、multipart false、模式媒体冲突扣费前拒绝。未宣称所有生产型号都完成真实生成。

## 验证记录

- 网站初次 9 个相关测试文件共 457 项通过，包含批量任务参数持久化、正常派发及重复请求不重复提交。推送前合并远端 V6K 新入口提交 `6a51344`，扩大到 11 个文件、542 项测试全部通过，并再次通过 TypeScript 检查；该提交的默认停用入口和既有接入逻辑完整保留。
- TypeScript 检查通过；插件原有生成测试 23 项、特殊参数测试 7 项、更新器测试 7 项通过。
- 隔离浏览器界面检查通过：中文枚举、布尔 false、数字 0、参数失效清除、窄面板无横向溢出、保留当前分辨率。未替代字字动画宿主的现场界面验收。
- 使用正式发布的 1.1.0 ZIP 内更新器，安装实际 1.1.1 ZIP 后再回退：文件逐一一致，测试配置与任务账本原字节保留。更新清单和下载传输在本地模拟，未宣称生产站已发布 1.1.1。
- 非压缩前端构建与隔离生产包启动检查通过，后者验证健康检查、页面、鉴权、更新清单与安装包大小/SHA-256。标准压缩构建因本机 Windows 删除 esbuild 临时文件被拒绝而失败；未修改生产构建配置，服务器部署仍需执行原构建流程。
- 发行包版本 1.1.1，35,201 字节，SHA-256：`031873e5bf3080f89c228f3a664f8b242558e5b398438e344b28abe1bb200433`。仅含插件的 5 个程序/说明文件，不含用户密钥、配置或任务记录。
