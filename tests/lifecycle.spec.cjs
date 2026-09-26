const {test, expect} = require('@playwright/test');
const QRCode = require('qrcode');
async function mockBlankCamera(page) {
  await page.addInitScript(() => {
    window.tracks = [];
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 200;
      const ctx = canvas.getContext('2d');
      const draw = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 200); };
      draw(); const stream = canvas.captureStream(12); const track = stream.getVideoTracks()[0];
      window.tracks.push(track); window.track = track;
      const timer = setInterval(() => { if (track.readyState === 'ended') clearInterval(timer); else draw(); }, 80);
      return stream;
    };
  });
}
test('repeated camera start/stop releases tracks', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Canvas camera mock');
  await mockBlankCamera(page); await page.goto('/');
  for (let i = 0; i < 3; i++) {
    await page.locator('#startButton').click();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'scanning');
    await page.locator('#stopButton').click();
    await expect(page.locator('#startButton')).toBeVisible();
  }
  expect(await page.evaluate(() => window.tracks.length)).toBe(3);
  expect(await page.evaluate(() => window.tracks.every(x => x.readyState === 'ended'))).toBe(true);
});
test('hidden page releases camera and never auto-restarts', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Canvas camera mock');
  await mockBlankCamera(page); await page.goto('/'); await page.locator('#startButton').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'scanning');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true, get:()=>true}); document.dispatchEvent(new Event('visibilitychange')); });
  expect(await page.evaluate(() => window.track.readyState)).toBe('ended');
  await expect(page.locator('#video')).toBeHidden();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true, get:()=>false}); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'idle');
  expect(await page.evaluate(() => window.tracks.length)).toBe(1);
});
test('result uses literal text and can be copied', async ({page}) => {
  await page.goto('/'); await expect(page.locator('#uploadButton')).toBeEnabled();
  const text = '<img src=x onerror=alert(1)> Привет';
  const url = await QRCode.toDataURL(text, {width: 500, errorCorrectionLevel:'H'});
  await page.locator('#fileInput').setInputFiles({name:'text.png', mimeType:'image/png', buffer:Buffer.from(url.split(',')[1], 'base64')});
  await expect(page.locator('#resultText')).toHaveValue(text);
  expect(await page.locator('#result img').count()).toBe(0);
  await expect(page.locator('#openLink')).toBeHidden();
  await page.locator('#copyButton').click();
  await expect(page.locator('#copyStatus')).not.toBeEmpty();
});
for (const theme of ['light','dark']) {
  test(`monochrome ${theme} responsive layouts`, async ({page}, info) => {
    await page.addInitScript(theme => localStorage.setItem('qr-theme', theme), theme);
    await page.goto('/'); await expect(page.locator('#uploadButton')).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({width, height: 900});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await page.locator('#preview').boundingBox();
      expect(Math.abs(box.width-box.height)).toBeLessThan(2);
      if (width===390 || width===1440) await info.attach(`${theme}-${width}`, {body:await page.screenshot({fullPage:true}), contentType:'image/png'});
    }
  });
}
