# 开源发布说明

这份说明用于确认公开仓库应该包含什么、不应该包含什么。

## 可公开内容

- `src/` 源码
- `scripts/` 中的通用开发和构建脚本
- `docs/` 中的公开部署、使用和架构说明
- `deploy/public.env.example` 等不含真实密钥的示例配置
- `.github/workflows/ci.yml` 基础 CI
- 公开图标、Logo、示例宣传图

## 不可公开内容

- `.company-local-*` 本地运行目录
- 帮派生成的真实报告、项目成果、弟子记忆和任务日志
- `.env`、API Key、访问 token、本地数据库
- 本机绝对路径、临时截图、E2E 录屏
- 旧品牌/旧云服务说明、内部迁移报告、个人操作备忘

## API Key 原则

江湖不内置任何大模型 API Key。公开仓库只提供配置入口：

- 本地环境变量
- 设置页保存到本地数据库的凭据
- 用户自己的部署环境变量

提交前应运行：

```bash
git status --short
git check-ignore -v .env .company-local-dev/data.db docs/DEHUMIDIFIER_MARKET_OPPORTUNITY.md
git grep -n -E "sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9_]{20,}|/Users/"
```

若 `git grep` 命中真实密钥、本机路径或旧品牌内容，应先清理再发布。

## 推荐 GitHub 仓库描述

> 江湖：本地优先的 AI 数字组织生态系统。把复杂目标交给天机阁，由临时帮派、帮主、弟子、藏经阁、钱庄和锦衣卫协同完成任务。

## 推荐 Topics

- `ai-agents`
- `multi-agent`
- `local-first`
- `workflow`
- `typescript`
- `react`
- `mcp`
- `ai-organization`
- `agent-skills`
