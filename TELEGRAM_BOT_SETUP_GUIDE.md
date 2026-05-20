# Telegram Bot 配置完成！

## ✅ 已完成的配置

1. **Bot创建成功**
   - Bot名称: @chong_zu_bot
   - Bot Token: 已配置
   - 连接状态: ✅ 已验证

2. **环境变量已设置**
   - `.env` 文件已创建
   - Bot Token已保存

## 📋 接下来的步骤

由于虫族运行在本地服务器，Telegram需要通过公网访问才能接收消息。您有两个选择：

### 选项1：使用ngrok（推荐用于测试）

```bash
# 1. 在新终端窗口启动ngrok
ngrok http 4800

# 2. 复制显示的Forwarding URL（如: https://abc123.ngrok.io）

# 3. 设置Webhook（替换YOUR_NGROK_URL）
curl -X POST "https://api.telegram.org/bot8727608374:AAEyVrUf1kJ53263HV1B2gkDlbZQi9HcGJo/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_NGROK_URL.ngrok.io/api/telegram/webhook"
  }'
```

### 选项2：暂时继续使用云端机器人（简单）

保持当前的云端机器人配置不变。云端服务虽然可能有延迟，但功能完整。

## 🧪 测试Bot

向 @chong_zu_bot 发送消息：
```
/start
```

## 🔧 修改Bot资料

在Telegram中向 @BotFather 发送：
- `/setdescription` - 设置描述
- `/setabouttext` - 设置关于信息
- `/setuserpic` - 设置头像

## 📊 当前配置状态

```
Bot Username: @chong_zu_bot
Bot Token: 8727608374:AAEy... (已保存到.env)
链接状态: ✅ 已链接
Telegram ID: 6385977101
```

## ❓ 如果Bot不回复

1. 检查服务器是否运行: `ps aux | grep "node.*serve"`
2. 检查端口: `lsof -i :4800`
3. 查看虫族日志中的错误信息
4. 确认Webhook设置: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`

---

**需要帮助？** 运行 `bash scripts/test-telegram.sh` 进行诊断
