#!/usr/bin/env node
/**
 * 本地Telegram Bot实现
 * 不依赖云端服务，直接处理Telegram消息
 */

const express = require('express')
const fetch = require('node-fetch')

const BOT_TOKEN = process.env.COMPANY_TELEGRAM_BOT_TOKEN
const WEBHOOK_PATH = '/api/telegram/webhook'
const PORT = 4800

if (!BOT_TOKEN) {
  console.error('❌ 错误: 请设置 COMPANY_TELEGRAM_BOT_TOKEN 环境变量')
  process.exit(1)
}

const app = express()
app.use(express.json())

// Telegram Webhook处理
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const message = req.body.message

    if (!message || !message.text) {
      return res.sendStatus(200)
    }

    const chatId = message.chat.id
    const text = message.text

    console.log(`📨 收到消息: ${text} (chatId: ${chatId})`)

    // 这里应该调用虫族的API来处理消息
    // 暂时回复一个确认消息
    await sendTelegramMessage(chatId, `收到您的消息: ${text}\n\n正在处理中...`)

    res.sendStatus(200)
  } catch (error) {
    console.error('处理消息错误:', error)
    res.sendStatus(500)
  }
})

// 发送Telegram消息
async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  })

  if (!response.ok) {
    throw new Error(`Telegram API错误: ${response.statusText}`)
  }

  return response.json()
}

// 获取Bot信息
async function getBotInfo() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getMe`
  const response = await fetch(url)
  const data = await response.json()

  if (data.ok) {
    console.log(`✅ Bot信息: @${data.result.username}`)
    return data.result
  } else {
    throw new Error(data.description)
  }
}

// 设置Webhook
async function setWebhook(webhookUrl, secret) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret
    })
  })

  const data = await response.json()

  if (data.ok) {
    console.log(`✅ Webhook设置成功: ${webhookUrl}`)
    return true
  } else {
    console.error(`❌ Webhook设置失败: ${data.description}`)
    return false
  }
}

// 获取Webhook信息
async function getWebhookInfo() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
  const response = await fetch(url)
  const data = await response.json()

  if (data.ok) {
    return data.result
  } else {
    throw new Error(data.description)
  }
}

// 删除Webhook
async function deleteWebhook() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`
  const response = await fetch(url)
  const data = await response.json()

  if (data.ok) {
    console.log('✅ Webhook已删除')
    return true
  } else {
    console.error(`❌ 删除Webhook失败: ${data.description}`)
    return false
  }
}

// 主函数
async function main() {
  const command = process.argv[2]

  try {
    switch (command) {
      case 'info':
        await getBotInfo()
        break

      case 'webhook': {
        const webhookUrl = process.argv[3]
        const secret = process.argv[4] || 'zuzu_secret'

        if (!webhookUrl) {
          console.error('❌ 请提供Webhook URL')
          console.log('用法: node telegram-local-bot.js webhook <url> [secret]')
          process.exit(1)
        }

        await setWebhook(webhookUrl, secret)
        break
      }

      case 'webhook-info': {
        const info = await getWebhookInfo()
        console.log(JSON.stringify(info, null, 2))
        break
      }

      case 'delete-webhook':
        await deleteWebhook()
        break

      case 'test': {
        const chatId = process.argv[3]
        const text = process.argv[4] || '测试消息'

        if (!chatId) {
          console.error('❌ 请提供chatId')
          console.log('用法: node telegram-local-bot.js test <chatId> [message]')
          process.exit(1)
        }

        await sendTelegramMessage(chatId, `🤖 虫族测试消息\n\n${text}`)
        console.log(`✅ 消息已发送到 ${chatId}`)
        break
      }

      default:
        console.log(`
本地Telegram Bot工具

用法:
  node telegram-local-bot.js info                           查看Bot信息
  node telegram-local-bot.js webhook <url> [secret]       设置Webhook
  node telegram-local-bot.js webhook-info                  查看Webhook信息
  node telegram-local-bot.js delete-webhook                删除Webhook
  node telegram-local-bot.js test <chatId> [message]       发送测试消息

环境变量:
  COMPANY_TELEGRAM_BOT_TOKEN    Telegram Bot Token (必需)

示例:
  # 1. 获取Bot信息
  COMPANY_TELEGRAM_BOT_TOKEN=123:ABC node telegram-local-bot.js info

  # 2. 设置Webhook（使用ngrok）
  COMPANY_TELEGRAM_BOT_TOKEN=123:ABC node telegram-local-bot.js webhook https://abc.ngrok.io/api/telegram/webhook

  # 3. 发送测试消息
  COMPANY_TELEGRAM_BOT_TOKEN=123:ABC node telegram-local-bot.js test 123456789 "你好"
        `)
    }
  } catch (error) {
    console.error('❌ 错误:', error.message)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { app, sendTelegramMessage }
