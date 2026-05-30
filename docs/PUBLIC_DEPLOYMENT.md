# 江湖公网部署指南

本项目默认是本地 AI 组织系统。公网部署时不要直接暴露本机 `4700` 端口，也不要把 `.company-local-dev` 上传到服务器。

推荐部署形态：

```text
用户浏览器
  ↓ HTTPS
Caddy 反向代理
  ↓ 内网 4700
江湖 Docker 容器
  ↓
Docker volume: /data/data.db
```

## 1. 服务器准备

需要一台 Linux 服务器，并安装 Docker 与 Docker Compose。把域名 A 记录指向服务器公网 IP。

示例域名：

```text
jianghu.example.com
```

## 2. 配置环境变量

在服务器项目目录中创建 `.env`：

```bash
cp deploy/public.env.example .env
```

编辑这些必填项：

```env
PUBLIC_DOMAIN=jianghu.example.com
ACME_EMAIL=you@example.com
COMPANY_ALLOWED_ORIGINS=https://jianghu.example.com
COMPANY_CLOUD_INSTANCE_ID=jianghu-prod-001
COMPANY_SECRET_KEY=<openssl rand -hex 32>
COMPANY_CLOUD_JWT_SECRET=<openssl rand -hex 32>
```

`COMPANY_SECRET_KEY` 用于本地密钥加密；`COMPANY_CLOUD_JWT_SECRET` 用于签发访问链接。二者都必须长期保存，丢失后旧数据或旧链接会失效。

如果希望线上实例一启动就能调用 AI，可以同时填入模型环境变量。当前模板保留了 MiMo、OpenAI、Claude、Gemini 的入口；也可以先不填，部署后在页面设置里配置。

## 3. 启动

```bash
docker compose -f docker-compose.public.yml --env-file .env up -d --build
```

查看日志：

```bash
docker compose -f docker-compose.public.yml logs -f jianghu
```

## 4. 签发访问链接

公网 cloud 模式不会自动给陌生浏览器发完整控制 token。你需要签发访问链接。

只读/协作成员链接，适合发给外部体验者：

```bash
set -a
. ./.env
set +a
node scripts/generate-cloud-token.mjs \
  --url https://jianghu.example.com \
  --role member \
  --days 7 \
  --user demo-001 \
  --name 体验用户
```

拥有完整控制权的链接，只给自己或可信管理员：

```bash
set -a
. ./.env
set +a
node scripts/generate-cloud-token.mjs \
  --url https://jianghu.example.com \
  --role user \
  --days 7 \
  --user owner \
  --name 管理员
```

区别：

- `member`：可查看江湖状态和有限协作，不能创建/删除帮派、改模型、改凭证。
- `user`：完整控制当前实例，能创建帮派、设置模型、改凭证、启动/暂停任务。

## 5. 数据和备份

数据在 Docker volume `jianghu-data` 中，对应容器内 `/data`。

备份：

```bash
docker compose -f docker-compose.public.yml stop jianghu
docker run --rm -v room-main_jianghu-data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'cd /data && tar czf /backup/jianghu-data-$(date +%Y%m%d-%H%M%S).tgz .'
docker compose -f docker-compose.public.yml start jianghu
```

## 6. 不要做的事

- 不要上传 `.company-local-dev`、`api.token`、`auth.tokens.json`、本机数据库或本地模型凭证。
- 不要把 `role=user` 链接公开发到群里。
- 不要在公网实例里开启真实钱包转账能力，除非你已经做完额外审计。
- 不要使用 `npm run dev:room` 作为公网长期服务。

## 7. 后续生产化方向

这套配置适合“自托管公网体验”。如果要做真正开放注册、多用户隔离、计费和权限分层，需要继续增加：

- OAuth 登录。
- 每个用户独立工作区/数据库隔离。
- 管理员后台。
- API 限流和任务预算硬限制。
- 队列化 agent 运行池。
- 审计日志导出与备份恢复界面。
