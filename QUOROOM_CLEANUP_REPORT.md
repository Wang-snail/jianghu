# Quoroom品牌引用清理报告

## ✅ 已清理的核心文件

### 1. 常量和配置
- **src/shared/constants.ts**
  - `APP_NAME = 'Quoroom'` → `APP_NAME = '虫族'`

### 2. 服务器端
- **src/server/routes/contacts.ts**
  - `process.env.QUOROOM_CLOUD_API` → `process.env.ZUZU_CLOUD_API`
  - `process.env.QUOROOM_TELEGRAM_BOT_USERNAME` → `process.env.ZUZU_TELEGRAM_BOT_USERNAME`
  - `process.env.QUOROOM_CONTACT_SECRET` → `process.env.ZUZU_CONTACT_SECRET`
  - `'quoroom-contact-secret'` → `'zuzu-contact-secret'`

### 3. UI组件
- **src/ui/App.tsx**
  - `'quoroom_port'` → `'zuzu_port'`
  - `'quoroom_tab'` → `'zuzu_tab'`
  - `'quoroom_room'` → `'zuzu_room'`
  - `'quoroom_setup_flow_room'` → `'zuzu_setup_flow_room'`
  - `'quoroom_early_banner_dismissed'` → `'zuzu_early_banner_dismissed'`
  - `'quoroom_local_mode_dismissed'` → `'zuzu_local_mode_dismissed'`
  - `'/.quoroom-dev/'` → `'/.虫族-dev/'`
  - `"quoroom serve"` → `"虫族 serve"`
  - `'hello@email.quoroom.ai'` → `'hello@zuzu.io'`

- **src/ui/main.tsx**
  - `'quoroom:pwa-cleanup-reload'` → `'zuzu:pwa-cleanup-reload'`
  - `'app.quoroom.io'` → `'app.zuzu.io'`
  - `'https://quoroom.io'` → `'https://zuzu.io'`

### 4. UI库
- **src/ui/lib/auth.ts**
  - `CLOUD_TOKEN_STORAGE_KEY = 'quoroom_cloud_token'` → `'zuzu_cloud_token'`
  - `CLOUD_MODE_FLAG_KEY = 'quoroom_cloud_mode'` → `'zuzu_cloud_mode'`
  - `'quoroom_port'` → `'zuzu_port'`
  - `"quoroom serve"` → `"虫族 serve"`

- **src/ui/lib/referrals.ts**
  - `'https://quoroom.io'` → `'https://zuzu.io'` (所有出现)

- **src/ui/lib/client.ts**
  - `'https://quoroom.io'` → `'https://zuzu.io'` (所有出现)

### 5. UI Hooks
- **src/ui/hooks/useTheme.ts**
  - `STORAGE_KEY = 'quoroom_theme'` → `'zuzu_theme'`

### 6. 样式
- **src/ui/styles/globals.css**
  - 注释：`'Quoroom Theme'` → `'虫族 Theme'`

### 7. 包配置
- **package.json**
  - `QUOROOM_DATA_DIR` → `ZUZU_DATA_DIR`
  - `QUOROOM_SKIP_MCP_REGISTER` → `ZUZU_SKIP_MCP_REGISTER`

## 📋 仍需处理的类别

### 高优先级
1. **安装器脚本** (`installers/`)
   - macOS: `QuoroomTray.swift`
   - Windows: `quoroom-tray.ps1`, `quoroom.nsi`, `stop-quoroom.ps1`

2. **文档文件**
   - `README.md`
   - `docs/CLERK.md`
   - `docs/CLOUD_MODE_PLAN.md`
   - 其他文档

### 中优先级
3. **测试文件**
   - `src/**/__tests__/*.test.ts`
   - `e2e/*.test.ts`

4. **脚本文件**
   - `scripts/*.js`
   - `scripts/*.sh`
   - `scripts/*.ps1`

### 低优先级
5. **构建产物**
   - `out/` 目录（自动生成）

6. **第三方配置**
   - `.github/` workflows
   - `dependabot` 配置

## 🔧 自动化工具

已创建批量清理脚本：
```bash
./scripts/cleanup-quoroom-references.sh
```

**使用说明：**
1. 给脚本添加执行权限：`chmod +x scripts/cleanup-quoroom-references.sh`
2. 运行脚本：`./scripts/cleanup-quoroom-references.sh`
3. 检查修改的文件
4. 提交更改

## 📝 手动检查建议

### 1. README.md
需要更新：
- 项目名称和描述
- 所有URL链接
- 安装说明
- 使用示例

### 2. 安装器文件
需要更新：
- 应用名称（"Quoroom" → "虫族"）
- 包标识符
- 脚本路径

### 3. 环境变量文档
需要更新：
- `.env.example`
- 所有环境变量名称说明
- 配置文档

## ⚠️ 重要注意事项

### 破坏性更改
1. **存储键名更改**
   - 用户现有的localStorage数据将丢失
   - 需要数据迁移脚本或清空存储

2. **环境变量更改**
   - 需要更新所有部署配置
   - 更新CI/CD配置

3. **URL更改**
   - 旧的分享链接将失效
   - 需要考虑向后兼容性

### 建议的迁移策略
1. 添加兼容层，同时支持新旧键名
2. 逐步迁移用户数据
3. 保留足够的过渡期
4. 发布迁移公告

## 🎯 下一步行动

1. ✅ 核心代码已清理
2. ⏳ 运行批量清理脚本处理剩余文件
3. ⏳ 手动更新文档和安装器
4. ⏳ 测试所有功能是否正常
5. ⏳ 发布迁移指南

## 📊 统计信息

- **总计扫描文件**: 150个文件
- **已手动清理**: 10个核心文件
- **已创建自动化脚本**: 1个
- **估计剩余文件**: ~140个（大部分是测试、文档、构建产物）

---

*生成时间: 2026-03-08*
*状态: 核心功能已完成，文档和安装器待处理*
