# 登录失效与重新登录修复

日期：2026-10-28。基线：origin/main `5a96777`。独立工作区：`scratch/login-session-fix`，分支：`codex/fix-login-session`；未修改原目录及 huss-final-publish 的既有改动。

## 已确认的代码问题

- 登录弹窗 → authStore.login → authApi.login → ApiClient：登录接口明确返回的 401「邮箱或密码错误」被客户端覆盖成「请先登录」或「登录已过期」，掩盖实际失败原因。
- ApiClient 按响应到达时的 token 清理登录状态，旧请求或匿名请求的迟到 401 可能删除重新登录刚取得的 token；清理后未同步用户状态。
- checkAuth / fetchProfile 把所有失败（含超时、网络错误、429、5xx）当成失效并删除 token；旧 profile 请求也可能覆盖新登录或退出状态。

## 修改

- 保留服务端错误正文、HTTP 状态及错误数据。公开登录接口的错误不注销现有登录。
- 使用请求发出时的 token 和会话版本匹配失效响应，只有当前会话的受保护请求 401 才注销；同步清除用户资料和页面登录状态。
- profile 检查按会话合并请求，忽略旧响应。临时故障保留凭证及已有登录状态，允许后续重试；冷启动尚未取得资料时仍保持未认证。
- 登录/注册取得新 token 后，仅匹配的新资料响应可以完成登录；退出取消仍在等待的登录。操作前的登录检查同时核对实际凭证。
- 未更改密码验证、JWT 有效期、服务器鉴权或权限规则。

## 验证

`tests/authSession.test.tsx` 新增 19 项测试，通过真实客户端、store 和登录弹窗验证，包括错误密码后纠正登录、过期后重登、旧请求在重登前后返回、相同 token 的新会话、临时错误/超时、启动失败重试、退出后迟到响应、不同会话的检查去重。

执行该文件及 canvasModelLoading、canvasGeneration、modelRoutingAdminWorkflow、videoCancellationPage、videoBatchPage、integration：7 个文件、114 项测试全部通过。`npm run lint`、`git diff --check` 通过。

`npm run build` 通过，保留原有分包警告。首次构建因系统临时目录文件删除权限失败，改用本工作区的临时目录后成功。

## 交付边界

已完成代码修复和模拟回归，提交及推送记录以 Git 为准。未部署，未取得该用户的线上请求或服务日志，因此这些已复现的代码缺陷不能视为该用户线上故障的唯一原因。
