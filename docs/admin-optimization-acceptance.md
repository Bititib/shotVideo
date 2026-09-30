# 管理体验优化与部署验收

更新日期：2026-09-29。目标站点：https://video.zhubo.asia ，部署方式：Docker Compose。

## 已实现

- 渠道详情内管理关联模型，模型内打开价格详情并编辑；返回时保留上下文。
- 渠道、模型、价格表格与卡片切换、排序与状态记忆；表格虚拟滚动，卡片每页 24 条。
- 模型价格、计费单位、独立或继承来源并列展示。
- 模型批量启停；价格按比例调整或统一设置，执行前预览，执行后逐条反馈失败。
- 编辑离开提醒与当前浏览器会话草稿恢复；草稿排除 API 凭据，24 小时过期。
- 配置先展示，价格和统计独立加载；统计缓存 30 秒，查询数不随模型数增长。
- 历史页面筛选、页码保存；刷新请求防止旧响应覆盖新筛选结果。
- 共享轮询避免并发重叠，隐藏或离线暂停，失败退避，离开时取消；请求超时提示。
- Docker 生产依赖包含 tsx，添加 `/api/health` 与容器健康检查，构建上下文排除环境配置文件。

## 本地验证

执行 `npm run lint`、`npm run build`，以及：

```sh
npx vitest run tests/adminEnhancements.test.ts tests/adminWorkflow.test.ts tests/adminView.test.ts tests/adminCache.test.ts tests/adminModelStats.test.ts tests/pricingResolution.test.ts tests/apiTimeout.test.ts
```

隔离预览：先构建，再运行 `node scripts/admin-preview.mjs`，打开 `http://127.0.0.1:4175/admin/channels`。
预览提供 2,000 个模拟模型、20 个渠道，所有修改仅保存在内存中，不连接真实数据库或上游。
已在浏览器验证渠道内查看模型、打开价格、修改并保存价格、关闭后模型价格更新且路由仍为渠道页。
截图：`output/admin-channel-price-acceptance.png`。

## 部署步骤（需要服务器连接与实际项目目录）

1. 确认实际 Compose 文件、环境配置、数据库挂载、反向代理指向；现有仓库默认宿主端口 3001。
2. 备份当前镜像和持久化数据；SQLite 应使用在线备份方式，或停止写入后备份整个数据目录（包括 WAL 文件）。保存环境配置和原 Compose 文件。
3. 将确认过的版本更新至服务器项目目录，保留服务器环境文件和持久化数据。
4. 在该目录执行 `docker compose build app`，构建成功后执行 `docker compose up -d --no-deps app`。
5. 执行 `docker compose ps`、`docker compose logs --tail=100 app`；检查容器健康状态及 HTTPS 访问。
6. 使用有权限的测试账号验收筛选保留、嵌套编辑、草稿、批量预览与失败反馈；真实业务价格不可用于试验。
7. 对真实数据测量配置与统计接口耗时、首屏和大列表滚动，记录设备与网络条件。需要回滚时恢复已备份镜像及对应配置，再重建 app 容器；禁止删除数据卷。

## 验证边界

- 线上公开首页已可访问；本地优化尚未部署，线上后台流程尚未验收。
- 本机没有可用 Docker 命令，尚未实测镜像构建和容器启动。
- 虚拟滚动控制页面节点数量；配置仍全量下载，不等同于服务端分页。
- 草稿为会话级存储，不跨设备；浏览器后退可能直接离开，但可返回恢复草稿。
- 当前构建仍提示 HEIC 转换组件较大（按需加载），没有声称线上加载速度提升比例。
