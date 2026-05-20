#!/usr/bin/env node
/**
 * 公司本地 UI中文翻译脚本
 * 自动翻译UI组件中的关键文本
 */

const fs = require('fs')
const path = require('path')

// 翻译映射表（按优先级排序，长字符串优先）
const TRANSLATIONS = {
  // 主导航
  'Dashboard': '控制面板',
  'Rooms': '公司',
  'Swarm': '员工团队',
  'Goals': '目标',
  'Skills': '技能',
  'Memory': '记忆',
  'Wallet': '钱包',
  'Settings': '设置',
  'Inbox': '收件箱',
  'Contacts': '联系人',
  'Tasks': '任务',
  'Votes': '会议',
  'Messages': '消息',
  'Stations': '站点',
  'Transactions': '交易',
  'Credentials': '凭证',
  'Help': '帮助',
  'Clerk': '书记官',

  // 状态
  'Active': '活跃',
  'Paused': '已暂停',
  'Stopped': '已停止',
  'Idle': '空闲',
  'Thinking': '思考中',
  'Acting': '执行中',
  'Voting': '会议中',
  'Loading...': '加载中...',
  'Error': '错误',
  'Success': '成功',
  'Failed': '失败',
  'active': '活跃',
  'paused': '已暂停',
  'stopped': '已停止',
  'idle': '空闲',

  // 操作按钮
  'Create Room': '创建公司',
  'Create Skill': '创建技能',
  'Start': '启动',
  'Stop': '停止',
  'Pause': '暂停',
  'Resume': '恢复',
  'Delete': '删除',
  'Save': '保存',
  'Cancel': '取消',
  'Edit': '编辑',
  'Confirm': '确认',
  'Refresh': '刷新',
  'Back': '返回',
  'Next': '下一步',
  'Close': '关闭',
  'Apply': '应用',
  'Reset': '重置',

  // 公司相关
  'Queen': '小老板',
  'Workers': '员工',
  'Quorum': '会议',
  'Model': '模型',
  'Nickname': '昵称',
  'Goal': '目标',
  'Visibility': '可见性',
  'Autonomy': '自主模式',
  'Max Concurrent Tasks': '最大并发任务数',
  'Room Name': '公司名称',
  'Status': '状态',
  'Private': '私有',
  'Public': '公开',
  'Room': '公司',
  'Worker': '员工',

  // Worker相关
  'Role': '角色',
  'System Prompt': '系统提示',
  'Agent State': '代理状态',
  'Cycle Gap': '循环间隔',
  'Max Turns': '最大轮次',
  'Votes Cast': '已会议数',
  'Votes Missed': '缺席会议',
  'WIP': '进行中',

  // 目标相关
  'Parent Goal': '父目标',
  'Sub-goals': '子目标',
  'Complete': '完成',
  'Progress': '进度',
  'Delegate': '委派',
  'Abandon': '放弃',
  'Description': '描述',
  'Assigned Worker': '分配员工',
  'completed': '已完成',
  'cancelled': '已取消',
  'in_progress': '进行中',

  // 技能相关
  'Skill Name': '技能名称',
  'Content': '内容',
  'Version': '版本',
  'Created By': '创建者',
  'Agent Created': 'AI创建',
  'Agent Self-Mod': 'AI自我修改',

  // 记忆相关
  'Remember': '记住',
  'Recall': '回忆',
  'Search': '搜索',
  'Entity': '实体',
  'Observation': '观察',
  'Relation': '关系',
  'Entities': '实体',
  'Observations': '观察记录',

  // 钱包相关
  'Balance': '余额',
  'Send': '发送',
  'Receive': '接收',
  'Address': '地址',
  'Transaction': '交易',
  'Copy Address': '复制地址',
  'Copied!': '已复制！',

  // Clerk相关
  'Commentary': '评论',
  'Mode': '模式',
  'Pace': '节奏',
  'Light': '轻量',
  'Auto': '自动',
  'Setup Clerk': '设置书记官',

  // 表单和输入
  'Name': '名称',
  'Type': '类型',
  'Value': '值',
  'Select...': '选择...',
  'Enter...': '输入...',
  'Search...': '搜索...',
  'Filter...': '筛选...',

  // 时间相关
  'Created At': '创建时间',
  'Updated At': '更新时间',
  'Last Active': '最后活跃',
  'Duration': '持续时间',

  // 提示和确认
  'No data available': '暂无数据',
  'An error occurred': '发生错误',
  'Are you sure?': '确定要执行此操作吗？',
  'This action cannot be undone': '此操作无法撤销',
}

// 需要翻译的组件文件列表
const UI_COMPONENTS = [
  'src/ui/App.tsx',
  'src/ui/demo.tsx',
  'src/ui/components/TabBar.tsx',
  'src/ui/components/StatusPanel.tsx',
  'src/ui/components/RoomsPanel.tsx',
  'src/ui/components/CreateRoomModal.tsx',
  'src/ui/components/RoomSettingsPanel.tsx',
  'src/ui/components/WorkersPanel.tsx',
  'src/ui/components/SwarmPanel.tsx',
  'src/ui/components/SkillsPanel.tsx',
  'src/ui/components/GoalsPanel.tsx',
  'src/ui/components/TasksPanel.tsx',
  'src/ui/components/MessagesPanel.tsx',
  'src/ui/components/VotesPanel.tsx',
  'src/ui/components/MemoryPanel.tsx',
  'src/ui/components/CredentialsPanel.tsx',
  'src/ui/components/ClerkPanel.tsx',
  'src/ui/components/StationsPanel.tsx',
  'src/ui/components/TransactionsPanel.tsx',
  'src/ui/components/SettingsPanel.tsx',
  'src/ui/components/HelpPanel.tsx',
  'src/ui/components/ContactPromptModal.tsx',
  'src/ui/components/WalkthroughModal.tsx',
  'src/ui/components/RoomSetupGuideModal.tsx',
  'src/ui/components/UpdateModal.tsx',
  'src/ui/components/CryptoStationModal.tsx',
  'src/ui/components/AutonomyControlGate.tsx',
  'src/ui/components/ConnectPage.tsx',
  'src/ui/components/PromptDialog.tsx',
  'src/ui/components/ConfirmDialog.tsx',
  'src/ui/components/ClerkSetupGuide.tsx',
  'src/ui/components/LiveConsoleSection.tsx',
  'src/ui/components/AnalogClock.tsx',
  'src/ui/components/CopyAddressButton.tsx',
]

function translateFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`跳过不存在的文件: ${filePath}`)
    return
  }

  let content = fs.readFileSync(filePath, 'utf-8')
  let modified = false
  let changeCount = 0

  // 应用翻译（按字符串长度降序，避免部分匹配）
  const sortedTranslations = Object.entries(TRANSLATIONS).sort((a, b) => b[0].length - a[0].length)

  for (const [en, zh] of sortedTranslations) {
    // 匹配单引号或双引号包裹的字符串
    const regex1 = new RegExp(`'${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g')
    const regex2 = new RegExp(`"${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')

    let newContent = content.replace(regex1, `'${zh}'`)
    newContent = newContent.replace(regex2, `"${zh}"`)

    if (newContent !== content) {
      const matches = content.match(regex1)?.length || 0
      const matches2 = content.match(regex2)?.length || 0
      changeCount += matches + matches2
      content = newContent
      modified = true
    }
  }

  // 保存修改后的文件
  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`✓ 已翻译 ${changeCount} 处: ${filePath}`)
  } else {
    console.log(`- 无需修改: ${filePath}`)
  }
}

// 执行翻译
console.log('🦟 公司本地 UI 组件中文翻译\n')
console.log('开始处理...\n')

UI_COMPONENTS.forEach(file => {
  const fullPath = path.join(process.cwd(), file)
  translateFile(fullPath)
})

console.log('\n✅ 翻译完成！')
console.log('\n提示: 请检查并手动调整以下内容：')
console.log('  1. 上下文不准确的翻译')
console.log('  2. 动态生成的文本（如日期、数字）')
console.log('  3. API返回的错误消息')
