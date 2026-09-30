# 上线配置与验收

## 必填配置

通过部署平台或 `.env.production` 注入，不要提交真实密钥：

```dotenv
NODE_ENV=production
JWT_SECRET=替换为至少32字符的随机密钥
ADMIN_PASSWORD=替换为至少12字符的管理员强密码
ADMIN_EMAIL=管理员邮箱
BACKEND_URL=https://你的域名
# 可选：网站前端与 BACKEND_URL 不同域时填写
# ALLOWED_ORIGINS=https://你的前端域名
MEDIA_USER_QUOTA_MB=2048
```

启动时校验必填生产配置。ALLOWED_ORIGINS 可不填，网站接口默认允许 BACKEND_URL 的来源。开放 API /v1 独立允许任意浏览器来源（不携带登录 Cookie），仍要求 API Key；不需要登记用户前端域名。已有管理员密码不会因环境变量改变而重置，需在后台另行修改旧密码。HTTPS 由部署平台或反向代理终止，转发到应用端口。禁止反向代理直接公开 `data/uploads` 或 `data/private-media`，所有素材请求必须经过应用鉴权，包括 `/uploads` 与 `/api/uploads`。

## 素材

登录用户画布同步时，把节点及历史版本内嵌的图片、视频、音频上传到 `data/private-media`，SQLite `private_media` 记录所有权和摘要。同账号相同文件去重，默认每账号 2 GB。访客仍保存到浏览器；登录后导入访客作品才上传。

数据库保存稳定的 `/api/media/:id` 地址，浏览器通过 HttpOnly 会话 Cookie 读取，后台验证账号启用状态和所有权。生成参考在后端验证后读取文件，不向上游暴露登录凭据。模型需要公网参考链接时，使用一小时签名链接。历史 `/uploads` 文件也要求账号归属或限时签名，图片和视频下载入口不再允许匿名读取本地文件。

目前采用**持久化服务器磁盘**，不是 S3/OSS；单实例部署必须挂载整个 `data` 目录。多实例部署前应接入统一对象存储并迁移 SQLite，不可各实例使用独立磁盘。未本地化的外部生成结果仍受上游保留时长影响。历史文件缺失所有权记录且未关联生成结果时，不自动猜测归属，需要管理员核对来源后迁移。

## 账务

自助模拟充值接口已关闭。后台“异常账单”显示预扣与待核对记录，超过 24 小时仍未结算的记录标记待核对，不自动退款。管理员必须查询上游任务结果、用量，确认任务已经终止后，填写实收与依据；差额在数据库事务内原路退回，重复提交不会重复退款。原用户或 API Key 已删除时拒绝自动退款。实收不得超过原预扣，超额费用由运营核对处理。

操作保存在 `billing_resolution_audit`，含操作人、时间、实收、退款与依据。旧视频任务继续沿用原恢复/退款流程，不会被新的对账入口重复处理。

## 备份和恢复

```sh
npm run backup
npm run backup -- --verify /绝对路径/备份目录
```

脚本使用 SQLite 在线备份，复制上传与私有素材，生成 SHA-256 清单并复核。失败时退出非零，不会修改或覆盖线上数据库。备份目录必须放在数据目录之外；生产备份还需复制到独立磁盘/服务并限制访问。容器内运行时先为 `/app/backups` 配置持久卷，或将备份导出到宿主机。密钥另行安全保存。

恢复演练：停止测试实例，将已校验备份中的 `app.db`、`uploads`、`private-media` 复制到一个空数据目录，挂载到隔离测试实例，禁止启动真实付费任务恢复；登录核对项目、素材和余额。确认后再安排线上停机恢复，不要直接覆盖运行中的 SQLite/WAL 文件。

## 发布前仍需线上完成

1. 使用真实部署环境构建镜像，验证健康检查和 HTTPS。
2. 两个测试账号验证上传、退出、换账号、刷新、跨设备保存；其他账号与无签名链接不能读取素材。
3. 受控小额验证实际模型任务成功、失败、部分成功和退款；核对上游消费与本站账单。
4. 验证持久卷容量与备份恢复，检查旧管理员密码已替换。

本地测试使用临时目录、内存数据库和模拟上游；不能替代上述线上验证。

## 手动更新现有 Docker 网站（Linux 服务器）

先等待生成队列清空，再更新。以下命令在服务器项目目录运行，不在本地 Windows 运行。现有网站的数据目录必须就是该目录下的 data；如果实际挂载不同，先以 docker inspect shot-video 的 Mounts 为准调整备份路径。

1. 备份并保留旧镜像：

```sh
cd /你的实际项目目录
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PWD/backups/$STAMP"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
git rev-parse HEAD > "$BACKUP_DIR/previous-commit.txt"
OLD_IMAGE=$(docker inspect --format '{{.Image}}' shot-video)
docker tag "$OLD_IMAGE" "shot-video:rollback-$STAMP"
cp .env.production "$BACKUP_DIR/env.production"
chmod 600 "$BACKUP_DIR/env.production"
docker compose stop app
tar -czf "$BACKUP_DIR/data.tar.gz" data
tar -tzf "$BACKUP_DIR/data.tar.gz" >/dev/null
```

任何一步报错就停止后续操作；如果备份失败，用 docker compose start app 恢复原容器，先解决备份问题。备份包含私密配置，不能提交 GitHub 或放入网站公开目录。

2. 拉取代码并检查配置：

```sh
git pull --ff-only origin main
nano .env.production
```

保留已有模型配置。按照本文“必填配置”补齐 JWT_SECRET、ADMIN_PASSWORD 和 BACKEND_URL；ALLOWED_ORIGINS 可不填；已有合格 JWT_SECRET 无需更换，更换会使现有登录失效。线上渠道密钥优先保留后台已有值；新建渠道可配置 SI_YUE_TIAN_API_KEY、MJNEWAPI_API_KEY、JULUN_API_KEY，缺少密钥的新渠道默认停用。历史源码内曾存在的渠道密钥应在服务商侧更换，不要重新粘回源码。

如果 git pull 报本地修改或分支冲突，停止更新并保留现场，不使用 git reset --hard 或 git clean。反向代理必须把 /uploads、/api/uploads 和 /api/media 请求交给应用，移除绕过应用鉴权的静态目录 alias。

3. 构建、校验并启动：

```sh
docker compose build app
docker compose run --rm --no-deps --entrypoint node app --import tsx -e "import('./server/config/env.ts')"
docker compose up -d --no-build app
docker compose ps
docker compose logs --tail=100 app
curl -f http://127.0.0.1:3001/api/health
```

健康检查成功后，再通过 HTTPS 网站验证登录、素材上传/播放/下载、画布保存和后台异常账单。更新不包含付费模型实测。不要执行 docker compose down -v，不要清空 data。

4. 如果更新失败，先保留故障日志。通过旧镜像回退应用：

```sh
printf 'services:\n  app:\n    image: shot-video:rollback-%s\n' "$STAMP" > "$BACKUP_DIR/rollback.yml"
docker compose -f docker-compose.yml -f "$BACKUP_DIR/rollback.yml" up -d --no-build app
```

这是代码回退，不会自动恢复数据库。如果启动迁移已改变数据，或必须恢复快照，请停机后先另存当前 data，再恢复备份；恢复会丢失备份后的任务和账务变化，不能直接覆盖正在运行的数据库。旧镜像可能保留旧安全问题，只用于临时恢复服务。
