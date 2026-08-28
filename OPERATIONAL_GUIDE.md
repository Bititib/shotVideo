# 运维与渠道配置指南 (Operational Guide)

本指南旨在指导管理员和运维人员如何配置外部 API 渠道、管理大模型属性、自定义销售价格以及进行多渠道扩容管理。

---

## 📊 0. 核心配置与转发流程图

为了方便快速理解，以下展示了系统的核心操作与请求流转逻辑：

### 流程一：添加与配置新中转站的完整链路
```mermaid
flowchart TD
    Start([开始接入新中转站]) --> Step1[1. 获取对方 API Key 和 Base URL]
    Step1 --> Step2[2. 管理后台 -> 📡 渠道管理 -> 添加渠道]
    Step2 --> Step3[3. 配置模型映射与权重，点击保存]
    Step3 --> Step4[4. 点击 '测试' 验证连通性]
    Step4 --> Step5{是否为系统全新模型?}
    Step5 -- 是 --> Step6[5. 管理后台 -> 🤖 大模型管理 -> 新建模型并勾选能力]
    Step5 -- 否 --> Step7[6. 管理后台 -> 💰 计费设置 -> 配置销售单价]
    Step6 --> Step7
    Step7 --> End([配置完成，用户/API 即可直接调用])
```

### 流程二：用户请求路由、计费与自动容灾重试机制
```mermaid
flowchart TD
    ReqInput([用户/API 发起生成请求]) --> CheckBal{系统检查账户余额是否充足?}
    CheckBal -- 否 --> ErrExit[拦截并提示余额不足]
    CheckBal -- 是 --> FindChan{匹配启用中的对应大模型渠道}
    FindChan -- 未配置渠道 --> ErrChan[报错: 未配置渠道]
    FindChan -- 找到可用渠道 --> PayReq[向下游中转渠道提交任务]
    PayReq --> Poll{轮询任务状态}
    Poll -- 处理中 --> Wait[等待 5 秒] --> Poll
    Poll -- 失败/超时 --> Retry{是否有其他备用渠道/重试次数?}
    Retry -- 是 --> FindChan
    Retry -- 否 --> FailRefund[提示生成失败, 不划扣余额]
    Poll -- 成功 --> Deduct[划扣当前时长对应积分] --> Save[保存视频并流式代理重写下载链接] --> End([完成生成])
```

---

## 📡 1. 配置上游 API Key (以接入 XS-Token 为例)

当系统需要调用第三方平台（如 [XS-Token](https://api.xs-token.com)）的模型时，需要为系统配置正确的访问凭证。

### 方式一：管理后台可视化配置 (推荐)
1. 登录系统，点击左下角的 **「管理后台」**。
2. 在左侧菜单中选择 **「📡 渠道管理」** (http://localhost:3000/admin/channels)。
3. 点击 **「添加渠道」**，配置如下参数：
   * **渠道名称**：`XS-Token 中转渠道`
   * **渠道类型**：`openai`
   * **Base URL**：`https://api.xs-token.com` （*注意：末尾不要加 `/v1`，后端在路由转发时会自动追加*）
   * **API Key**：填入您在外部平台申请的真实密钥（形如 `sk-xxxxxxxxxxxxxxxxxxxxxxxx`）
   * **支持模型 (Supported Models)**：按行填入需要通过此中转站派发的模型标识（如 `sora-v4-fast`）
4. 点击 **「保存」**。
5. 在列表中找到该渠道，点击右侧的 **「测试」**。若提示 `✅ 测试成功`，说明配置就绪。

### 方式二：环境变量后备配置
如果数据库中未配置针对特定模型的专用渠道，系统会回退使用环境变量配置：
1. 打开项目根目录下的 [.env](file:///d:/2026-07-04_0129/--main/.env) 文件。
2. 修改或添加以下两项配置：
   ```ini
   GROK2API_BASE_URL=https://api.xs-token.com
   GROK2API_API_KEY=sk-你的真实APIKey
   ```
3. 保存并重启后台服务以使环境变量生效。

---

## 🤖 2. 修改模型展示名称

系统支持动态修改前端页面和开发者中心展示给用户的模型名称：

1. 登录超级管理员账号，进入 **「管理后台」**。
2. 选择 **「🤖 大模型管理」** (http://localhost:3000/admin/models)。
3. 在模型列表中找到要编辑的模型（如 ID 为 `sora-v4-fast` 的行），点击右侧 of **「编辑」**。
4. 修改 **「显示名称」**（如改为 `Sora 快速生成` 或 `Sora-V4 (快速超清)`）。
5. 点击 **「保存」**，刷新前端视频生成页面即可即时看到更改。

> [!NOTE]
> 如果您希望出厂时就将默认名字写死，也可以直接在代码中修改 [video.ts:DEFAULT_VIDEO_MODELS](file:///d:/2026-07-04_0129/--main/server/routes/video.ts) 的 `name` 属性。

---

## 💰 3. 自定义销售价格 (二次加价)

为了向您的用户（包括网页端用户与通过 API 调用的企业客户）进行二次加价扣费，价格修改已被绑定到了数据库系统设置中。

### 网页端 & API 统一秒级价格修改
1. 登录超级管理员账号，进入 **「管理后台」**。
2. 选择 **「⚙️ 系统设置」**（或设置管理）。
3. 找到项目：`Sora V4 720p费率(¥/秒)`。
4. 点击编辑，将其值由默认的 `1.50` 修改为您的理想零售价（如 `2.00` 或 `3.00` 积分/秒）。
5. 点击 **「保存」**。保存后，网页版生成以及 API 外部调用将同时按照新价格进行余额预估和划扣。

### 针对特定 Token 的个性化计费 (API 计费规则)
如果您希望对某些普通用户或 API 渠道设置不同的按次或按 Token 计费规则：
1. 进入 **「管理后台 -> 💰 计费设置 / 计费管理」**。
2. 点击 **「添加规则」**，输入匹配的 **「模型匹配模式」**（如 `sora-v4-fast`）。
3. 选择计费类型（如 `按次计费`）并配置单次扣除金额，点击保存。

---

## 📡 4. 接入其他第三方中转站 (分流与备用)

当您未来需要引入其他的中转站以实现降本增效、负载均衡或高可用时，可按以下流程配置：

```mermaid
graph TD
    A[发起视频生成请求] --> B{查找可用渠道}
    B -- 匹配模型ID --> C[中转渠道 A (权重 10)]
    B -- 匹配模型ID --> D[中转渠道 B (权重 5)]
    C -- 请求失败/超时 --> E[自动重试并切换]
    E --> D
    D --> F[返回结果]
    C -- 请求成功 --> F
```

### 步骤 A：新建渠道
1. 进入 **「管理后台 -> 📡 渠道管理」**，点击 **「添加渠道」**。
2. 配置新中转站的 `Base URL`、`API Key`。
3. 在 **「支持模型 (Supported Models)」** 中填入您要分发给此中转站的模型（如 `sora-v4-fast`）。
4. **使用名称映射（非常实用）**：
   * 如果该中转站上模型的名字与您的系统名字不一致（例如，对方的名字叫 `sora-v4-fast-custom`，但您的系统对外暴露的叫 `sora-v4-fast`），可在渠道的 **「模型映射 (Model Mapping)」** 中填入：
     `sora-v4-fast:sora-v4-fast-custom`
   * 系统在转发请求给该渠道时，会自动将模型名进行重写替换。
5. 设置该渠道的 **「权重 (Weight)」**。系统会自动根据权重进行负载分流；如果权重高的渠道请求失败，系统会自动无缝重试权重较低的备用渠道。

### 步骤 B：添加新大模型 (如有需要)
如果新中转站引入了之前系统**未曾支持**的全新模型：
1. 进入 **「管理后台 -> 🤖 大模型管理」**，点击 **「添加模型」**。
2. 登记其 `模型ID`、`显示名称`，勾选其支持的能力属性（如 `video`）。
3. 进入 **「管理后台 -> 💰 计费设置」**，为新模型添加费率扣费标准，使其对客户生效。

---

## 🚀 5. 如何部署与更新项目到 VPS (Docker 方式)

本系统已预配置好完整的 Docker 部署方案，包含 [Dockerfile](file:///d:/2026-07-04_0129/--main/Dockerfile)（多阶段构建）和 [docker-compose.yml](file:///d:/2026-07-04_0129/--main/docker-compose.yml)。

> [!IMPORTANT]
> **数据安全说明**：SQLite 数据库文件通过 Docker Volume 挂载在宿主机的 `./data` 目录下，重新构建镜像**不会**丢失数据。只要不手动删除 `./data` 目录，用户数据、渠道配置、余额等全部安全。

### Docker 部署架构
```mermaid
flowchart LR
    subgraph VPS 宿主机
        Nginx["Nginx 反向代理 (443/80)"]
        subgraph Docker 容器 shot-video
            App["Node.js + Vite 静态文件 (端口 3000)"]
        end
        Data["./data/sqlite.db (持久化挂载)"]
        EnvFile[".env.production (环境变量)"]
    end
    User([用户浏览器/API]) --> Nginx --> |"3001:3000"| App
    App --> Data
    App --> EnvFile
```

---

### 首次部署 (全新 VPS)

#### 步骤一：在本地提交并推送代码
```bash
git add .
git commit -m "feat: 接入在线文档与 Sora V4 Fast (Seedance 2.0) 支持"
git push
```

#### 步骤二：在 VPS 上克隆项目
```bash
# SSH 登录 VPS 后
cd /www/wwwroot
git clone https://github.com/你的用户名/你的仓库名.git video-creative-storm
cd video-creative-storm
```

#### 步骤三：配置生产环境变量
```bash
# 创建生产环境变量文件（docker-compose 会自动加载此文件）
cp .env .env.production

# 编辑并填入真实的上游 API Key 等配置
nano .env.production
```

> [!TIP]
> `.env.production` 文件中需要确保以下关键配置项已填写：
> ```ini
> GROK2API_BASE_URL=https://api.xs-token.com
> GROK2API_API_KEY=sk-你的真实APIKey
> JWT_SECRET=你的JWT密钥（建议使用随机长字符串）
> ```

#### 步骤四：构建镜像并启动容器
```bash
# 一键构建并后台启动（首次会自动下载 node:22-alpine 基础镜像）
docker compose up -d --build
```

#### 步骤五：验证运行状态
```bash
# 查看容器运行状态
docker compose ps

# 查看实时日志
docker compose logs -f app

# 测试本地端口是否正常响应
curl http://localhost:3001
```

---

### 日常更新 (代码改动后重新部署)

当您在本地完成开发并推送到 GitHub 后，在 VPS 上只需执行以下命令即可完成热更新：

```bash
# 1. 进入项目目录
cd /www/wwwroot/video-creative-storm

# 2. 拉取最新代码
git pull

# 3. 重新构建镜像并重启容器（数据不会丢失）
docker compose up -d --build
```

> [!NOTE]
> `docker compose up -d --build` 会自动完成以下操作：
> - 重新编译前端静态文件（Vite build）
> - 重新安装后端生产依赖
> - 用新镜像替换旧容器
> - 自动挂载 `./data` 目录，保留所有数据库数据

---

### 常用 Docker 运维命令速查

| 操作 | 命令 |
|------|------|
| 启动服务 | `docker compose up -d` |
| 停止服务 | `docker compose down` |
| 重新构建并启动 | `docker compose up -d --build` |
| 查看运行状态 | `docker compose ps` |
| 查看实时日志 | `docker compose logs -f app` |
| 查看最近 100 行日志 | `docker compose logs --tail=100 app` |
| 进入容器内部调试 | `docker compose exec app sh` |
| 备份数据库 | `cp ./data/sqlite.db ./data/sqlite.db.bak` |
| 清理旧镜像（释放磁盘） | `docker image prune -f` |

---

### Nginx 反向代理参考配置

docker-compose.yml 中容器默认映射端口为 `宿主机 3001 → 容器 3000`，配合 Nginx 的参考配置如下：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # 限制上传体大小（需与后端 body-parser 限制一致或更大，支持参考视频上传）
    client_max_body_size 150m;

    ssl_certificate     /etc/ssl/your-domain.com.pem;
    ssl_certificate_key /etc/ssl/your-domain.com.key;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 支持 SSE 流式响应（大模型对话需要）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    # 视频文件下载代理（支持大文件）
    location /v1/files/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_max_temp_file_size 0;
    }
}
```

---

## HM Studio 并发与排队

HM Studio 图片和视频共用同一个公平队列。默认全局最多同时运行 10 项，每个用户最多同时运行 2 项；用户之间轮询调度，同一用户内部按提交顺序执行。

可通过 `.env` 调整：

```env
HM_STUDIO_CONCURRENCY=10
HM_STUDIO_USER_CONCURRENCY=2
HM_STUDIO_MAX_USER_QUEUE=10
HM_STUDIO_MAX_QUEUE=200
```

- `HM_STUDIO_CONCURRENCY`：HM 账号全局运行上限。
- `HM_STUDIO_USER_CONCURRENCY`：每个用户或 API Token 的同时运行上限。
- `HM_STUDIO_MAX_USER_QUEUE`：单用户最多等待任务数，超过返回 `429`。
- `HM_STUDIO_MAX_QUEUE`：全局最多等待任务数，超过返回 `429`。

API 用户可调用 `GET /v1/queue` 查看当前运行数、排队数和限制。视频任务还会通过创建响应及任务查询接口返回 `queue_position`、`queue_running` 和 `queue_limit`。
