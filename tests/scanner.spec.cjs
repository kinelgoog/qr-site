const {test, expect} = require('@playwright/test');
const QRCode = require('qrcode');
const payload = 'https://example.com/group?source=tochka';
async function qrImage(page, text, variant = 'plain') {
  const source = await QRCode.toDataURL(text, {width: 640, margin: 4, errorCorrectionLevel: 'H'});
  const data = await page.evaluate(async ({source, variant}) => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 640;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 640);
    if (variant === 'blur') ctx.filter = 'blur(0.65px)';
    ctx.drawImage(image, 0, 0); ctx.filter = 'none';
    if (variant === 'logo') {
      ctx.fillStyle = '#fff'; ctx.fillRect(276, 276, 88, 88);
      ctx.fillStyle = '#6941ba'; ctx.fillRect(287, 287, 66, 66);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('VK', 320, 330);
    }
    if (variant === 'glare') {
      const gradient = ctx.createLinearGradient(150, 0, 460, 0);
      gradient.addColorStop(0, 'rgba(255,255,255,0)'); gradient.addColorStop(.5, 'rgba(255,255,255,.28)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 640);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, {source, variant});
  return Buffer.from(data, 'base64');
}
async function upload(page, buffer) {
  await page.locator('#fileInput').setInputFiles({name: 'qr.png', mimeType: 'image/png', buffer});
}
for (const variant of ['plain', 'logo', 'glare', 'blur']) {
  test(`decodes ${variant} image locally`, async ({page}) => {
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
    await page.goto('/');
    await upload(page, await qrImage(page, payload, variant));
    await expect(page.locator('#resultText')).toHaveValue(payload);
    await expect(page.locator('#openLink')).toHaveAttribute('href', payload);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });
}
test('unsafe content stays text; repeated upload works', async ({page}) => {
  await page.goto('/');
  const text = 'javascript:alert("QR")';
  const buffer = await qrImage(page, text);
  await upload(page, buffer); await expect(page.locator('#resultText')).toHaveValue(text);
  await expect(page.locator('#openLink')).toBeHidden();
  await upload(page, buffer); await expect(page.locator('#resultText')).toHaveValue(text);
});
test('theme persists and narrow screen does not overflow', async ({page}) => {
  await page.goto('/');
  const before = await page.locator('html').getAttribute('data-theme');
  await page.locator('#themeButton').click(); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark');
  await page.setViewportSize({width: 320, height: 700});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.locator('#preview').boundingBox();
  expect(Math.abs(box.width - box.height)).toBeLessThan(2);
});
test('invalid image gives a recoverable error', async ({page}) => {
  await page.goto('/');
  await upload(page, Buffer.from('not an image'));
  await expect(page.locator('#status')).toHaveAttribute('data-error', 'true');
  await expect(page.locator('#startButton')).toBeVisible();
  await upload(page, await qrImage(page, payload));
  await expect(page.locator('#resultText')).toHaveValue(payload);
});
test('camera denial keeps photo upload available', async ({page}) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.goto('/'); await page.locator('#startButton').click();
  await expect(page.locator('#status')).toHaveAttribute('data-error', 'true');
  await expect(page.locator('#uploadButton')).toBeEnabled();
});
test('camera crop matches square and stops tracks after decode', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Canvas stream simulation is tested in Chromium');
  const source = await QRCode.toDataURL(payload, {width: 600, margin: 4, errorCorrectionLevel: 'H'});
  await page.addInitScript(({source}) => {
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async () => {
      const image = new Image(); image.src = source; await image.decode();
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const ctx = c.getContext('2d');
      const draw = () => {ctx.fillStyle='#fff';ctx.fillRect(0,0,1280,720);ctx.drawImage(image,340,60,600,600)};
      draw(); const stream = c.captureStream(12); window.testTrack = stream.getVideoTracks()[0];
      const id = setInterval(() => { if(window.testTrack.readyState==='ended')clearInterval(id);else draw(); },80);
      return stream;
    };
  }, {source});
  await page.goto('/'); await page.locator('#startButton').click();
  await expect(page.locator('#resultText')).toHaveValue(payload);
  await expect.poll(() => page.evaluate(() => window.testTrack?.readyState)).toBe('ended');
});
test('cancel ignores late camera permission and stops acquired track', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Canvas stream simulation is tested in Chromium');
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      window.grantCamera = () => {
        const c=document.createElement('canvas');c.width=c.height=100;
        const s=c.captureStream();window.testTrack=s.getVideoTracks()[0];resolve(s);
      };
    });
  });
  await page.goto('/'); await page.locator('#startButton').click();
  await expect.poll(() => page.evaluate(() => typeof window.grantCamera)).toBe('function');
  await page.locator('#stopButton').click(); await page.evaluate(() => window.grantCamera());
  await expect.poll(() => page.evaluate(() => window.testTrack.readyState)).toBe('ended');
  await expect(page.locator('#video')).toBeHidden();
});
