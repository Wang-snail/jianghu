const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false, // 显示浏览器窗口以便观察
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  try {
    console.log('正在访问 http://localhost:4800 ...');

    // 访问页面
    await page.goto('http://localhost:4800', { waitUntil: 'networkidle', timeout: 30000 });

    // 等待页面完全加载
    console.log('等待页面加载...');
    await page.waitForTimeout(5000);

    // 截取完整页面截图
    const screenshotPath = '/Users/woniu/dm/其他尝试/公司/room-main/artifacts/zerg-page-full.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('截图已保存:', screenshotPath);

    // 获取页面文本内容
    const pageText = await page.textContent('body');
    console.log('\n===== 页面文本内容 =====');
    console.log(pageText);

    // 检查特定元素
    console.log('\n===== 检查导航菜单 =====');
    const navItems = await page.locator('nav a, nav button').allTextContents();
    console.log('导航菜单项:', navItems);

    console.log('\n===== 检查按钮文本 =====');
    const buttons = await page.locator('button').allTextContents();
    console.log('按钮文本:', buttons.filter(t => t.trim()));

    console.log('\n===== 检查标题 =====');
    const title = await page.title();
    console.log('页面标题:', title);

    // 检查 h1, h2 标题
    const headings = await page.locator('h1, h2, h3').allTextContents();
    console.log('页面标题元素:', headings.filter(t => t.trim()));

    // 查找所有英文文本（简单检测：包含常见英文单词）
    console.log('\n===== 可能的英文文本 =====');
    const allText = pageText;
    const englishPatterns = [
      'Overview', 'Objectives', 'Messages', 'Drones', 'Settings',
      'Create Room', 'Join Room', 'Login', 'Logout', 'Dashboard'
    ];
    const foundEnglish = englishPatterns.filter(pattern => allText.includes(pattern));
    if (foundEnglish.length > 0) {
      console.log('发现英文文本:', foundEnglish);
    } else {
      console.log('未发现明显的英文文本');
    }

    // 检查 localStorage 中的语言设置
    console.log('\n===== 检查语言设置 =====');
    const localStorage = await page.evaluate(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        items[key] = localStorage.getItem(key);
      }
      return items;
    });
    console.log('localStorage:', JSON.stringify(localStorage, null, 2));

    // 检查是否有 lang 属性
    const htmlLang = await page.locator('html').getAttribute('lang');
    console.log('HTML lang 属性:', htmlLang);

  } catch (error) {
    console.error('测试过程中出错:', error.message);
  } finally {
    await browser.close();
  }
})();
