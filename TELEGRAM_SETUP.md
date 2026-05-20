# Telegram 机器人设置指南

## 问题原因
当前系统使用云端服务 (quoroom.io) 处理Telegram消息，如果云端服务有问题，机器人就不会回复。

## 解决方案：配置自己的Telegram机器人

### 步骤1：创建Telegram机器人

1. 在Telegram中搜索 `@BotFather`
2. 发送 `/newbot` 命令
3. 按提示输入机器人名称（例如：`My Zuzu Bot`）
4. 按提示输入机器人用户名（例如：`my_zuzu_bot`，必须以 `_bot` 结尾）
5. BotFather会发送一个Token，格式如：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
6. **保存这个Token！**

### 步骤2：设置Webhook

由于虫族是本地运行，您需要使用ngrok等工具暴露本地服务器：

```bash
# 安装ngrok
brew install ngrok

# 启动ngrok隧道（假设虫族运行在4800端口）
ngrok http 4800

# 会得到一个URL，如：https://abc123.ngrok.io
```

### 步骤3：配置环境变量

编辑 `.env` 文件：

```bash
QUOROOM_TELEGRAM_BOT_USERNAME=your_bot_username
QUOROOM_TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_WEBHOOK_SECRET=your_random_secret_string
```

### 步骤4：设置Webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-ngrok-url.ngrok.io/api/telegram/webhook",
    "secret_token": "your_random_secret_string"
  }'
```

### 步骤5：测试机器人

在Telegram中向您的机器人发送任何消息，应该会收到回复。

---

## 快速测试（无需Webhook）

如果不想设置Webhook，可以使用轮询模式（仅用于测试）：

```bash
# 临时设置
export QUOROOM_TELEGRAM_BOT_TOKEN="your_token_here"

# 测试发送消息
curl -X POST "https://api.telegram.org/bot$QUOROOM_TELEGRAM_BOT_TOKEN/getMe"
```

---

## 常见问题

### 1. 机器人不回复
- 检查Token是否正确
- 检查Webhook是否设置成功
- 检查ngrok隧道是否正常运行
- 查看服务器日志

### 2. Webhook设置失败
- 确保URL可以通过公网访问
- 检查URL格式是否正确
- 确保端口没有被防火墙阻止

### 3. 回复延迟
- 这是正常的，取决于网络和AI处理速度
