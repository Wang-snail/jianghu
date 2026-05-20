import { test, expect } from '@playwright/test';

test.describe('虫族界面中文化验证测试', () => {
  test('验证主界面和房间界面中文显示', async ({ page }) => {
    // 访问测试页面
    await page.goto('http://localhost:4800');

    // 等待页面加载
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    await page.waitForTimeout(3000);

    // 尝试关闭可能出现的模态框
    const closeButtons = page.locator('button:has-text("×"), button:has-text("Skip"), button:has-text("关闭")');
    const count = await closeButtons.count();
    for (let i = 0; i < count; i++) {
      try {
        await closeButtons.nth(i).click({ timeout: 2000 });
        await page.waitForTimeout(500);
      } catch {
        // 忽略错误
      }
    }

    // 截取主页面
    await page.screenshot({
      path: '/Users/woniu/dm/其他尝试/公司/room-main/artifacts/chinese-verification-main.png',
      fullPage: true
    });

    // 先检查页面结构，找出所有可能的链接
    console.log('\n=== 页面结构分析 ===\n');
    const allLinks = await page.locator('a').all();
    console.log(`找到 ${allLinks.length} 个链接:`);

    for (let i = 0; i < Math.min(allLinks.length, 20); i++) {
      const text = await allLinks[i].textContent();
      const href = await allLinks[i].getAttribute('href');
      if (text && text.trim()) {
        console.log(`  ${i}: "${text.trim()}" -> ${href || '(无href)'}`);
      }
    }

    // 获取主页面文本内容
    const mainPageText = await page.textContent('body');
    console.log('\n=== 主页面分析 ===\n');

    // 检查是否有房间列表
    const hasRoomList = mainPageText?.includes('final-test') || mainPageText?.includes('test-fs');
    console.log(`是否有房间: ${hasRoomList ? '是' : '否'}`);

    // 尝试通过URL直接访问房间页面
    // 假设房间ID为1，尝试访问 /rooms/1 或类似的路径
    console.log('\n尝试直接访问房间页面...');

    // 先检查可能的房间URL模式
    const possibleUrls = [
      'http://localhost:4800/rooms/1',
      'http://localhost:4800/room/1',
      'http://localhost:4800/r/1',
    ];

    let roomPageVisited = false;
    for (const url of possibleUrls) {
      try {
        const response = await page.goto(url);
        await page.waitForTimeout(3000);

        // 检查是否成功加载（非404）
        if (response && response.status() !== 404) {
          const roomPageText = await page.textContent('body');

          // 检查是否是房间详情页（有特定的房间内容）
          if (roomPageText?.includes('Overview') || roomPageText?.includes('概览') ||
              roomPageText?.includes('Messages') || roomPageText?.includes('消息')) {
            console.log(`成功访问房间页面: ${url}`);
            roomPageVisited = true;

            // 截取房间页面
            await page.screenshot({
              path: '/Users/woniu/dm/其他尝试/公司/room-main/artifacts/chinese-verification-room.png',
              fullPage: true
            });

            // 分析房间页面
            await analyzeRoomPage(page, roomPageText);
            break;
          }
        }
      } catch (e) {
        console.log(`  ${url}: 无法访问`);
        // 继续尝试下一个URL
      }
    }

    if (!roomPageVisited) {
      console.log('\n无法直接访问房间页面，分析主页面...');
      await analyzeMainPage(page, mainPageText);
    }
  });
});

async function analyzeRoomPage(page: any, roomPageText: string) {
  console.log('\n=== 房间页面详细分析 ===\n');

  // 检查 MessagesPanel
  const messagesPanelZh = roomPageText?.includes('消息');
  const messagesPanelEn = roomPageText?.includes('Messages');
  console.log(`MessagesPanel - 标题: ${messagesPanelZh ? '中文"消息" ✓' : messagesPanelEn ? '英文"Messages" ✗' : '未找到'}`);

  // 检查 Status/Overview Panel 标题
  const statusPanelZh = roomPageText?.includes('概览');
  const statusPanelEn = roomPageText?.includes('Status');
  const overviewEn = roomPageText?.includes('Overview');
  console.log(`StatusPanel - 标题: ${statusPanelZh ? '中文"概览" ✓' : statusPanelEn ? '英文"Status" ✗' : overviewEn ? '英文"Overview" ✗' : '未找到'}`);

  // 检查卡片文字
  console.log(`\n卡片文字检查:`);
  const memoryCard = roomPageText?.includes('记忆');
  const workersCard = roomPageText?.includes('工蜂');
  const tasksCard = roomPageText?.includes('任务');
  const recentActivityCard = roomPageText?.includes('最近活动');
  const walletCard = roomPageText?.includes('钱包');
  const queenCard = roomPageText?.includes('Queen');
  const networkCard = roomPageText?.includes('Network');
  const tokenUsageCard = roomPageText?.includes('Token Usage');

  console.log(`  - 记忆 (Memory): ${memoryCard ? '中文 ✓' : '英文 ✗'}`);
  console.log(`  - 工蜂 (Workers): ${workersCard ? '中文 ✓' : '英文 ✗'}`);
  console.log(`  - 任务 (Tasks): ${tasksCard ? '中文 ✓' : '英文 ✗'}`);
  console.log(`  - 最近活动 (Recent Activity): ${recentActivityCard ? '中文 ✓' : '英文 ✗'}`);
  console.log(`  - 钱包 (Wallet): ${walletCard ? '中文 ✓' : '英文 ✗'}`);
  console.log(`  - Queen: ${queenCard ? '英文 ✗' : '✓ (已翻译或不存在)'}`);
  console.log(`  - Network: ${networkCard ? '英文 ✗' : '✓ (已翻译或不存在)'}`);
  console.log(`  - Token Usage: ${tokenUsageCard ? '英文 ✗' : '✓ (已翻译或不存在)'}`);

  // 检查状态标签
  console.log(`\n状态标签检查:`);
  const runningZh = roomPageText?.includes('运行中');
  const activeZh = roomPageText?.includes('活跃');
  const pausedZh = roomPageText?.includes('已暂停');
  const completedZh = roomPageText?.includes('已完成');
  const stoppedZh = roomPageText?.includes('已停止');
  const idleZh = roomPageText?.includes('空闲');

  console.log(`  - "运行中": ${runningZh ? '✓' : '✗'}`);
  console.log(`  - "活跃": ${activeZh ? '✓' : '✗'}`);
  console.log(`  - "已暂停": ${pausedZh ? '✓' : '✗'}`);
  console.log(`  - "已完成": ${completedZh ? '✓' : '✗'}`);
  console.log(`  - "已停止": ${stoppedZh ? '✓' : '✗'}`);
  console.log(`  - "空闲": ${idleZh ? '✓' : '✗'}`);

  // 检查Queen状态
  const queenRunningEn = roomPageText?.match(/\bRunning\b/);
  console.log(`\nQueen卡片:`);
  console.log(`  - "Running" 状态: ${queenRunningEn ? '英文 ✗' : '✓ (无英文)'}`);

  // 检查按钮文字
  console.log(`\n按钮文字检查:`);
  const sendEn = roomPageText?.match(/\bSend\b/);
  const sendZh = roomPageText?.includes('发送');
  const replyEn = roomPageText?.match(/\bReply\b/);
  const replyZh = roomPageText?.includes('回复');
  const cancelEn = roomPageText?.match(/\bCancel\b/);
  const cancelZh = roomPageText?.includes('取消');
  const createEn = roomPageText?.match(/\bCreate\b/);
  const createZh = roomPageText?.includes('新建') || roomPageText?.includes('创建');
  const expandAllZh = roomPageText?.includes('全部展开');
  const collapseAllZh = roomPageText?.includes('全部收起');
  const markAllReadZh = roomPageText?.includes('全部标记为已读');

  console.log(`  - Send: ${sendEn ? '英文 ✗' : sendZh ? '中文 ✓' : '未找到'}`);
  console.log(`  - Reply: ${replyEn ? '英文 ✗' : replyZh ? '中文 ✓' : '未找到'}`);
  console.log(`  - Cancel: ${cancelEn ? '英文 ✗' : cancelZh ? '中文 ✓' : '未找到'}`);
  console.log(`  - Create/New: ${createEn ? '英文 ✗' : createZh ? '中文 ✓' : '未找到'}`);
  console.log(`  - 全部展开: ${expandAllZh ? '✓' : '✗'}`);
  console.log(`  - 全部收起: ${collapseAllZh ? '✓' : '✗'}`);
  console.log(`  - 全部标记为已读: ${markAllReadZh ? '✓' : '✗'}`);

  // 检查占位符文字
  console.log(`\n输入框占位符检查:`);
  const placeholders = await page.locator('input[placeholder], textarea[placeholder]').all();
  const placeholderTexts: string[] = [];
  for (const input of placeholders) {
    const placeholder = await input.getAttribute('placeholder');
    if (placeholder) {
      placeholderTexts.push(placeholder);
    }
  }
  const uniquePlaceholders = [...new Set(placeholderTexts)];
  console.log(`  找到 ${uniquePlaceholders.length} 个占位符:`);
  for (const p of uniquePlaceholders) {
    const isEnglish = p.match(/^[A-Z]/) || p.includes('your') || p.includes('Type') || p.includes('Ask');
    console.log(`    ${isEnglish ? '✗ ' : '✓ '}"${p}"`);
  }

  // 检查英文占位符
  const englishPlaceholders = uniquePlaceholders.filter(p =>
    p.match(/^[A-Z]/) || p.includes('your') || p.includes('Type') || p.includes('Ask')
  );

  // 检查 Timeline/Console 切换按钮
  console.log(`\n视图切换按钮:`);
  const timelineEn = roomPageText?.includes('Timeline');
  const consoleEn = roomPageText?.includes('Console');
  const timelineZh = roomPageText?.includes('时间线');
  const consoleZh = roomPageText?.includes('控制台');
  console.log(`  - Timeline: ${timelineEn ? '英文 ✗' : timelineZh ? '中文 ✓' : '未找到'}`);
  console.log(`  - Console: ${consoleEn ? '英文 ✗' : consoleZh ? '中文 ✓' : '未找到'}`);

  // 检查 Filters 相关文字
  console.log(`\n过滤器相关:`);
  const filtersEn = roomPageText?.includes('Filters');
  const clearEn = roomPageText?.match(/\bClear\b/);
  const allEn = roomPageText?.match(/\bAll\b/);
  console.log(`  - Filters: ${filtersEn ? '英文 ✗' : '✓'}`);
  console.log(`  - Clear: ${clearEn ? '英文 ✗' : '✓'}`);
  console.log(`  - All: ${allEn ? '英文 ✗' : '✓'}`);

  // 检查事件类型标签
  console.log(`\n事件类型标签:`);
  const eventTypes = ['decision', 'milestone', 'financial', 'deployment', 'worker', 'error', 'system'];
  for (const type of eventTypes) {
    const hasEn = roomPageText?.includes(type);
    const hasZh = roomPageText?.includes({
      decision: '决策',
      milestone: '里程碑',
      financial: '财务',
      deployment: '部署',
      worker: '工蜂',
      error: '错误',
      system: '系统',
    }[type]);
    console.log(`  - ${type}: ${hasZh ? '中文 ✓' : hasEn ? '英文 ✗' : '未找到'}`);
  }

  // 计算翻译进度
  console.log(`\n=== 翻译进度总结 ===\n`);

  const allChecks = [
    { name: 'MessagesPanel标题', passed: !!messagesPanelZh },
    { name: 'StatusPanel标题', passed: !!statusPanelZh },
    { name: '记忆卡片', passed: !!memoryCard },
    { name: '工蜂卡片', passed: !!workersCard },
    { name: '任务卡片', passed: !!tasksCard },
    { name: '最近活动卡片', passed: !!recentActivityCard },
    { name: '钱包卡片', passed: !!walletCard },
    { name: 'Queen已翻译', passed: !queenCard },
    { name: 'Network已翻译', passed: !networkCard },
    { name: 'Token Usage已翻译', passed: !tokenUsageCard },
    { name: '运行中状态', passed: !!runningZh },
    { name: '活跃状态', passed: !!activeZh },
    { name: '已暂停状态', passed: !!pausedZh },
    { name: '已完成状态', passed: !!completedZh },
    { name: '空闲状态', passed: !!idleZh },
    { name: 'Send按钮', passed: !sendEn },
    { name: 'Reply按钮', passed: !replyEn },
    { name: 'Cancel按钮', passed: !cancelEn },
    { name: 'Create按钮', passed: !createEn },
    { name: '全部展开', passed: !!expandAllZh },
    { name: '全部收起', passed: !!collapseAllZh },
    { name: '全部标记为已读', passed: !!markAllReadZh },
    { name: '无英文占位符', passed: englishPlaceholders.length === 0 },
    { name: 'Timeline已翻译', passed: !timelineEn },
    { name: 'Console已翻译', passed: !consoleEn },
    { name: 'Filters已翻译', passed: !filtersEn },
    { name: 'Clear已翻译', passed: !clearEn },
  ];

  const passed = allChecks.filter(c => c.passed).length;
  const total = allChecks.length;
  const percentage = Math.round((passed / total) * 100);

  console.log(`翻译进度: ${percentage}% (${passed}/${total} 项通过)`);
  console.log('\n详细结果:');
  allChecks.forEach(check => {
    console.log(`  ${check.passed ? '✓' : '✗'} ${check.name}`);
  });

  // 列出需要修复的项目
  const failedItems = allChecks.filter(c => !c.passed).map(c => c.name);
  if (failedItems.length > 0) {
    console.log('\n=== 需要修复的项目 ===');
    failedItems.forEach(item => {
      console.log(`  - ${item}`);
    });
  }
}

async function analyzeMainPage(page: any, pageText: string | null) {
  console.log('\n=== 主页面分析 ===\n');

  // 检查标签页文字
  const tabs = [
    { name: 'Overview', zh: '概览' },
    { name: 'Messages', zh: '消息' },
    { name: 'Workers', zh: '工蜂' },
    { name: 'Settings', zh: '设置' },
    { name: 'Votes', zh: '投票' },
  ];

  console.log('标签页文字:');
  for (const tab of tabs) {
    const hasEn = pageText?.includes(tab.name);
    const hasZh = pageText?.includes(tab.zh);
    console.log(`  - ${tab.name}: ${hasEn ? '英文' : hasZh ? '中文' : '未找到'}`);
  }

  // 检查其他按钮文字
  const buttons = [
    { name: 'New Room', zh: '新建房间' },
    { name: 'Invite', zh: '邀请' },
    { name: 'Global Settings', zh: '全局设置' },
    { name: 'Help', zh: '帮助' },
  ];

  console.log('\n按钮文字:');
  for (const btn of buttons) {
    const hasEn = pageText?.includes(btn.name);
    const hasZh = pageText?.includes(btn.zh);
    console.log(`  - ${btn.name}: ${hasEn ? '英文' : hasZh ? '中文' : '未找到'}`);
  }
}
