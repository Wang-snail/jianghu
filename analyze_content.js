const { chromium } = require('./node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 }
  });

  console.log('Navigating to http://localhost:4800...');
  await page.goto('http://localhost:4800', { waitUntil: 'networkidle' });

  // Wait for content to load
  await page.waitForTimeout(5000);

  // Screenshot full page
  await page.screenshot({ path: '/tmp/analysis-full.png', fullPage: true });
  console.log('Full screenshot saved to /tmp/analysis-full.png');

  // Get page text
  const pageText = await page.evaluate(() => {
    return document.body.innerText;
  });

  console.log('\n========== PAGE TEXT CONTENT ==========\n');
  console.log(pageText);

  // Look for all visible buttons
  const buttons = await page.evaluate(() => {
    const btns = [];
    document.querySelectorAll('button').forEach(b => {
      const text = b.textContent.trim();
      if (text && b.offsetParent !== null) {
        btns.push(text);
      }
    });
    return btns;
  });

  console.log('\n========== VISIBLE BUTTONS ==========\n');
  buttons.forEach(b => console.log(`  - ${b}`));

  // Look for inputs
  const inputs = await page.evaluate(() => {
    const inps = [];
    document.querySelectorAll('input, textarea').forEach(i => {
      if (i.offsetParent !== null) {
        inps.push({
          tag: i.tagName,
          type: i.type || 'text',
          placeholder: i.placeholder || '',
          name: i.name || ''
        });
      }
    });
    return inps;
  });

  console.log('\n========== VISIBLE INPUTS ==========\n');
  inputs.forEach(i => console.log(`  - ${i.tag}: type=${i.type}, placeholder="${i.placeholder}"`));

  // Look for any dialogs/modals
  const overlays = await page.evaluate(() => {
    const results = [];
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'absolute') {
        const zIndex = parseInt(style.zIndex) || 0;
        if (zIndex > 10) {
          const text = el.textContent.trim().substring(0, 100);
          if (text) {
            results.push({
              tag: el.tagName,
              zIndex: zIndex,
              position: style.position,
              display: style.display,
              text: text,
              class: el.className
            });
          }
        }
      }
    }
    return results;
  });

  console.log('\n========== OVERLAY ELEMENTS (z-index > 10) ==========\n');
  overlays.forEach(o => {
    console.log(`  [${o.tag}] z=${o.zIndex}, pos=${o.position}, display=${o.display}`);
    console.log(`    text: ${o.text.substring(0, 100)}`);
  });

  // Save results
  const fs = require('fs');
  fs.writeFileSync('/tmp/page-text.txt', pageText);
  fs.writeFileSync('/tmp/page-analysis.json', JSON.stringify({
    buttons,
    inputs,
    overlays,
    fullText: pageText
  }, null, 2));

  console.log('\n========== RESULTS SAVED ==========');
  console.log('  - /tmp/analysis-full.png');
  console.log('  - /tmp/page-text.txt');
  console.log('  - /tmp/page-analysis.json');

  await browser.close();
})();
