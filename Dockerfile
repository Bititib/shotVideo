# ===== 阶段1: 构建前端 =====
FROM node:22-alpine AS builder

WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存层
COPY package.json package-lock.json ./
RUN npm ci

# 复制源代码并构建前端
COPY . .
RUN cd client && npx vite build

# ===== 阶段2: 生产镜像 =====
FROM node:22-alpine AS production

WORKDIR /app

# 安装 better-sqlite3 编译依赖
RUN apk add --no-cache python3 make g++

# 仅安装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++

# 从 builder 阶段复制构建产物
COPY --from=builder /app/client/dist ./client/dist

# 复制后端代码
COPY server/ ./server/
COPY tsconfig.json ./

# 创建数据目录
RUN mkdir -p /app/data

# 环境变量
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 数据持久化
VOLUME ["/app/data"]

# 启动
CMD ["npx", "tsx", "server/index.ts"]
