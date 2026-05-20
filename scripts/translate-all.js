#!/usr/bin/env node
/**
 * 批量翻译所有UI组件
 */

const fs = require('fs')
const path = require('path')

// 完整的翻译映射表
const TRANSLATIONS = {
  // 导航和面板
  'Overview': '概览',
  'My Swarm': '我的虫群',
  'Decisions': '决策',
  'Milestones': '里程碑',
  'Financial': '财务',
  'Deployment': '部署',
  'Errors': '错误',
  'System': '系统',
  'Self-Mod': '自我修改',
  
  // 状态相关
  'running': '运行中',
  'stopped': '已停止',
  'paused': '已暂停',
  'idle': '空闲',
  'in_progress': '进行中',
  'completed': '已完成',
  'cancelled': '已取消',
  'failed': '失败',
  'pending': '待处理',
  
  // 操作
  'Run': '运行',
  'Pause': '暂停',
  'Resume': '恢复',
  'View': '查看',
  'Add': '添加',
  'Remove': '移除',
  'Update': '更新',
  'Create': '创建',
  'Manage': '管理',
  'Configure': '配置',
  
  // 描述和提示
  'No workers found': '未找到员工',
  'No tasks found': '未找到任务',
  'No goals found': '未找到目标',
  'No skills found': '未找到技能',
  'No votes found': '未找到会议',
  'No messages found': '未找到消息',
  'No transactions found': '未找到交易',
  'No events found': '未找到事件',
  
  // 空状态
  'Nothing to see here': '这里什么都没有',
  'No data available': '暂无数据',
  'No items found': '未找到项目',
  
  // 按钮和操作
  'Create Room': '创建公司',
  'New Room': '新建公司',
  'Save Changes': '保存更改',
  'Dismiss': '忽略',
  'Learn More': '了解更多',
  'Get Started': '开始使用',
  'Continue': '继续',
  'Done': '完成',
  
  // Worker 相关
  'Agent': '代理',
  'Worker Name': '员工名称',
  'Queen': '小老板',
  'Executor': '执行者',
  'Model': '模型',
  'System Prompt': '系统提示',
  'Max Turns': '最大轮次',
  'Cycle Gap': '循环间隔',
  'WIP': '进行中',
  
  // Task 相关
  'Task Name': '任务名称',
  'Task Status': '任务状态',
  'Assigned To': '分配给',
  'Due Date': '截止日期',
  'Priority': '优先级',
  'High': '高',
  'Medium': '中',
  'Low': '低',
  
  // Goal 相关
  'Goal Status': '目标状态',
  'Parent Goal': '父目标',
  'Sub-goals': '子目标',
  'Mark Complete': '标记完成',
  'Delegate': '委派',
  
  // 技能相关
  'Skill Description': '技能描述',
  'Skill Version': '技能版本',
  'Agent Created': 'AI创建',
  
  // Vote 相关
  'Vote Status': '会议状态',
  'Active': '活跃',
  'Approved': '已批准',
  'Rejected': '已拒绝',
  'Pending': '待处理',
  'Abstained': '弃权',
  
  // Clerk 相关
  'Clerk Mode': '书记官模式',
  'Commentary': '评论',
  'Active': '活跃',
  'Light': '轻量',
  'Auto': '自动',
  
  // Settings 相关
  'General': '常规',
  'Advanced': '高级',
  'API Keys': 'API密钥',
  'Providers': '提供商',
  'Integrations': '集成',
  'About': '关于',
  'Version': '版本',
  
  // 钱包相关
  'Wallet Balance': '钱包余额',
  'Send Transaction': '发送交易',
  'Receive Payment': '接收付款',
  'Transaction History': '交易历史',
  'From Address': '来自地址',
  'To Address': '目标地址',
  'Amount': '金额',
  'Fee': '费用',
  
  // 时间相关
  'Just now': '刚刚',
  'A minute ago': '1分钟前',
  'minutes ago': '分钟前',
  'An hour ago': '1小时前',
  'hours ago': '小时前',
  'A day ago': '1天前',
  'days ago': '天前',
  
  // 通知和提示
  'Loading...': '加载中...',
  'Saving...': '保存中...',
  'Processing...': '处理中...',
  'Please wait...': '请稍候...',
  'Operation successful': '操作成功',
  'Operation failed': '操作失败',
  
  // 其他
  'Show': '显示',
  'Hide': '隐藏',
  'Expand': '展开',
  'Collapse': '收起',
  'Filter': '筛选',
  'Sort': '排序',
  'Group': '分组',
  'Export': '导出',
  'Import': '导入',
}

// 需要翻译的组件文件
const UI_COMPONENTS = [
  'src/ui/components/StatusPanel.tsx',
  'src/ui/components/WorkersPanel.tsx',
  'src/ui/components/TasksPanel.tsx',
  'src/ui/components/GoalsPanel.tsx',
  'src/ui/components/SkillsPanel.tsx',
  'src/ui/components/VotesPanel.tsx',
  'src/ui/components/MessagesPanel.tsx',
  'src/ui/components/SwarmPanel.tsx',
  'src/ui/components/ClerkPanel.tsx',
  'src/ui/components/MemoryPanel.tsx',
  'src/ui/components/CredentialsPanel.tsx',
  'src/ui/components/TransactionsPanel.tsx',
  'src/ui/components/StationsPanel.tsx',
  'src/ui/components/SettingsPanel.tsx',
  'src/ui/components/CreateRoomModal.tsx',
  'src/ui/components/WalkthroughModal.tsx',
  'src/ui/components/UpdateModal.tsx',
  'src/ui/components/RoomSetupGuideModal.tsx',
  'src/ui/components/ContactPromptModal.tsx',
  'src/ui/components/HelpPanel.tsx',
]

function translateFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`跳过不存在的文件: ${filePath}`)
    return 0
  }

  let content = fs.readFileSync(filePath, 'utf-8')
  let modified = false
  let changeCount = 0

  // 按字符串长度降序排序，避免部分匹配
  const sortedTranslations = Object.entries(TRANSLATIONS).sort((a, b) => b[0].length - a[0].length)

  for (const [en, zh] of sortedTranslations) {
    // 转义特殊字符
    const escapedEn = en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    
    // 匹配单引号或双引号包裹的字符串
    const regex1 = new RegExp(`'${escapedEn}'`, 'g')
    const regex2 = new RegExp(`"${escapedEn}"`, 'g')

    let newContent = content.replace(regex1, `'${zh}'`)
    newContent = newContent.replace(regex2, `"${zh}"`)

    if (newContent !== content) {
      const matches1 = content.match(regex1)?.length || 0
      const matches2 = content.match(regex2)?.length || 0
      changeCount += matches1 + matches2
      content = newContent
      modified = true
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`✓ 已翻译 ${changeCount} 处: ${path.basename(filePath)}`)
  } else {
    console.log(`- 无需修改: ${path.basename(filePath)}`)
  }
  
  return changeCount
}

console.log('🦟 公司本地 UI 组件批量中文翻译\n')
console.log('开始处理...\n')

let totalChanges = 0
UI_COMPONENTS.forEach(file => {
  const fullPath = path.join(process.cwd(), file)
  totalChanges += translateFile(fullPath)
})

console.log(`\n✅ 翻译完成！共修改 ${totalChanges} 处`)
console.log('\n下一步: npm run build:ui')
