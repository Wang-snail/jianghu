// 江湖 UI 中文翻译
const translations: Record<string, string> = {
  // 主导航
  'Dashboard': '控制面板',
  'Rooms': '帮派',
  'Swarm': '我的江湖',
  'Goals': '委托目标',
  'Skills': '功法',
  'Memory': '藏经阁',
  'Wallet': '钱庄账户',
  'Settings': '设置',
  'Inbox': '收件箱',
  'Contacts': '联系人',
  'Clerk': '秘书',
  'Tasks': '镖单',
  'Votes': '议事堂',
  'Messages': '飞鸽传书',
  'Stations': '灵气资源',
  'Transactions': '钱庄',
  'Credentials': '访问凭证',
  'Help': '江湖说明',

  // 状态
  'Active': '活跃',
  'Paused': '已暂停',
  'Stopped': '已停止',
  'Idle': '空闲',
  'Thinking': '思考中',
  'Acting': '执行中',
  'Voting': '议事中',
  'Loading...': '加载中...',
  'Error': '错误',
  'Success': '成功',
  'Failed': '失败',
  'Rate Limited': '限流中',

  // 操作按钮
  'Create Room': '创建帮派',
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

  // 房间相关
  'Queen': '天机阁',
  'Workers': '弟子',
  'Quorum': '议事堂',
  'Model': '模型',
  'Nickname': '昵称',
  'Goal': '委托',
  'Goals': '委托目标',
  'Visibility': '可见性',
  'Autonomy': '自主模式',
  'Max Concurrent Tasks': '最大并发镖单数',
  'Room Name': '帮派名称',
  'Status': '状态',
  'Private': '私有',
  'Public': '公开',

  // Worker相关
  'Worker': '弟子',
  'Role': '司职',
  'System Prompt': '弟子心法',
  'Agent State': '弟子状态',
  'Cycle Gap': '循环间隔',
  'Max Turns': '最大轮次',
  'Votes Cast': '已发言数',
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
  'Assigned Worker': '分配弟子',

  // 技能相关
  'Create Skill': '创建技能',
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
  'Just now': '刚刚',
  'minutes ago': '分钟前',
  'hours ago': '小时前',
  'days ago': '天前',

  // 通知消息
  'Room created successfully': '房间创建成功',
  'Room deleted': '房间已删除',
  'Settings saved': '设置已保存',
  'Worker started': '员工已启动',
  'Worker stopped': '员工已停止',
  'Goal completed': '目标已完成',
  'Skill created': '技能已创建',
  'Error loading data': '加载数据出错',
  'No data available': '暂无数据',
  'An error occurred': '发生错误',

  // 提示和确认
  'Are you sure?': '确定要执行此操作吗？',
  'This action cannot be undone': '此操作无法撤销',
  'Unauthorized': '未授权',
  'Connection lost': '连接断开',
  'Reconnecting...': '重连中...',

  // 其他常用术语
  'API Key': 'API密钥',
  'Provider': '提供商',
  'Subscription': '订阅',
  'Token': '代币',
  'Network': '网络',
  'Gas Fee': '燃料费',
  'Transaction Hash': '交易哈希',
  'Chain': '链',
  'From': '来自',
  'To': '到',
  'Amount': '金额',
  'Date': '日期',
  'Hash': '哈希',
}

export function t(key: string): string {
  return translations[key] || key
}

export default translations
