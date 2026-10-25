# 试卷资料共享站 (Railway 轻量部署)

## 环境变量 (仅管理员账号密码)
| 变量 | 说明 |
|---|---|
| `ADMIN_USER` | 管理员用户名 |
| `ADMIN_PASS` | 管理员密码 |
| `REDIS_URL` | Redis 连接（Railway Redis 提供，如 `redis://default:pass@host:port`） |
| `TIDB_URL` | TiDB 连接（可选，`mysql://user:pass@host:4000/db`） |
| `BACKEND` | `redis`（默认）或 `tidb` |
| `SESSION_SECRET` | 可选，会话签名密钥 |

## Railway 部署
1. 推送本仓库到 GitHub。
2. Railway → New Project → Deploy from GitHub repo。
3. Railway 中添加 Redis 插件（Variables 会自动注入 `REDIS_URL`）。
4. 设置环境变量 `ADMIN_USER` / `ADMIN_PASS`。512MB 内存即可，用量约 $0.23/天以内按需计费。
5. 登录管理员账号（admin 用户名密码登录后自动跳转 `/admin.html`），配置：站点名、SMTP、GitHub Token/仓库、GitCode 镜像、积分规则。

## 功能
- 注册/登录需答 2 道 100 以内算术题，作答 <1.2 秒判定机器人驳回
- 注册需邮箱验证码（SMTP），手机号仅校验格式与重复
- 文件上传到 GitHub Release，重命名为 `ID.扩展名`，上传 +10 积分
- 下载三选一：GitHub 直连（提示可能慢）/ 服务器中转（每500KB扣3积分）/ GitCode 镜像（每3天自动同步，未同步不显示）
- 自建分类、资料评分（1-5星+评论，每人一次）
- 管理后台：数据看板、成本估计（预算 $0.9）、全部配置项、成本调整建议
- 所有数据存 Redis/TiDB（KV 模式），服务器不保留本地数据

## 成本控制 (目标 ≤ $0.03/天)
- 内存: Node 堆上限 96MB，Railway 建议内存上限 128MB（$10/GB/月 → 约 $0.9/月内）
- 中转下载为流式转发，不缓冲整个文件，避免内存峰值
- mysql2 按需加载，未用 TiDB 时不占内存
- 前台文件优先直连/镜像，不经过服务器；中转下载可后台一键关闭
- 单实例，冷启动为 Node 单进程，秒级唤醒
