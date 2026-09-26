const {test, expect} = require('@playwright/test');
const QRCode = require('qrcode');

const payload = 'https://example.com/rotated?from=photo';

async function tiltedPhoto(page, angle, options = {}) {
  const source = await QRCode.toDataURL(payload, {
    width: 480,
    margin: 4,
    errorCorrectionLevel: 'M'
  });
  const data = await page.evaluate(async ({source, angle, options}) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const width = options.width || 1200;
    const height = options.height || 900;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#8f8b84');
    background.addColorStop(1, '#5d5a55');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width * (options.cx || 0.5), height * (options.cy || 0.5));
    ctx.rotate(angle * Math.PI / 180);
    const size = options.size || 420;
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
    ctx.restore();
    return canvas.toDataURL('image/png').split(',')[1];
  }, {source, angle, options});
  return Buffer.from(data, 'base64');
}

const cases = [
  {title: '30 degrees', angle: 30},
  {title: '45 degrees', angle: 45},
  {title: '135 degrees', angle: 135},
  {title: '200 degrees', angle: 200},
  {title: '40 degrees, small code in a large photo', angle: 40,
    options: {width: 2400, height: 1800, size: 300, cx: 0.32, cy: 0.36}}
];

for (const {title, angle, options} of cases) {
  test(`decodes photo with code tilted ${title}`, async ({page}) => {
    await page.goto('/');
    await page.locator('#fileInput').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: await tiltedPhoto(page, angle, options)
    });
    await expect(page.locator('#resultText')).toHaveValue(payload, {timeout: 30000});
  });
}
