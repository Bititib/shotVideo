# 纵横科技仅使用 V6K 视频接口

旧的视频协议已移除，不再调用旧站提交、/v1/tasks 查询或 /v1/media 上传。

## 上线配置

1. 更新启动后，原纵横渠道统一为 V6K 类型。使用旧站地址的渠道自动改为 https://www.v6k.top 并暂时停用，避免将旧站密钥当作新站凭据使用。
2. 后台编辑原渠道，填入 V6K 站点创建的新令牌，测试连接并同步模型，核对精确模型 ID、时长、分辨率及售价后启用。
3. 如模型使用销售路由，核对线路所用渠道 ID。原渠道记录 ID 保留，不需要重建账单或删除历史记录。
4. BACKEND_URL 使用本站公网 HTTPS 地址，确保 /reference-assets/ 可由上游读取。参考素材使用随机名称的稳定文件链接。

## 历史订单

已完成的视频、历史失败记录及账单均保留。未完成的旧协议任务停止自动查询并显示待核实，保留任务 ID 和原扣款，不自动重提或退款。管理员核实原结果后处理；不能假设旧任务 ID 在新站可用。

## 新任务

- POST /v1/videos，使用 seconds/images/videos/audios，保存返回的 id。
- GET /v1/videos/{id}，识别 queued/in_progress/completed/failed，通常每 20 秒查询，临时错误退避并尊重 Retry-After。
- GET /v1/videos/{id}/content，由服务器携带新站令牌下载并保存；浏览器和其他下载域名不会收到令牌。
- 明确提交拒绝或任务失败只退款一次；查询和下载错误继续处理原任务。504、断网或缺少 ID 且接单结果不明时待核实，禁止自动重提。
- 文档未确认首尾帧、quality、negative_prompt、generate_audio；这些选项会在生成前明确报错。

文档：https://www.v6k.top/docs?guide=unified&category=video

测试使用模拟上游和独立数据库；真实权限和付费生成链路需要上线后使用新站令牌验证。
