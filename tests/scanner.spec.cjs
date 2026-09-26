const {test, expect} = require('@playwright/test');
const QRCode = require('qrcode');

const payload = 'https://example.com/group?source=tochka';
const uiVariants = [
  {title: 'plain', variant: 'plain'},
  {title: 'square logo', variant: 'logo-square'},
  {title: 'round logo', variant: 'logo-round'},
  {title: 'glare', variant: 'glare'},
  {title: 'blur', variant: 'blur'},
  {title: 'low contrast rotated', variant: 'low-contrast-rotate'}
];

async function qrImage(page, text, variant = 'plain') {
  const source = await QRCode.toDataURL(text, {
    width: 640,
    margin: 4,
    errorCorrectionLevel: 'H'
  });
  const data = await page.evaluate(async ({source, variant}) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 640;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 640, 640);
    ctx.save();
    ctx.translate(320, 320);
    if (variant === 'low-contrast-rotate') ctx.rotate(11 * Math.PI / 180);
    const size = variant === 'low-contrast-rotate' ? 560 : 640;
    if (variant === 'blur') ctx.filter = 'blur(0.65px)';
    ctx.drawImage(image, -size / 2, -size / 2, size, size);
    ctx.restore();
    ctx.filter = 'none';
    if (variant === 'logo-square') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(276, 276, 88, 88);
      ctx.fillStyle = '#6941ba';
      ctx.fillRect(287, 287, 66, 66);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('VK', 320, 322);
    }
    if (variant === 'logo-round') {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(320, 320, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6941ba';
      ctx.beginPath();
      ctx.arc(320, 320, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('QR', 320, 321);
    }
    if (variant === 'glare') {
      const gradient = ctx.createLinearGradient(150, 0, 460, 0);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(.5, 'rgba(255,255,255,.28)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 640, 640);
    }
    if (variant === 'low-contrast-rotate') {
      const pixels = ctx.getImageData(0, 0, 640, 640);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const light = pixels.data[i] > 127;
        pixels.data[i] = light ? 245 : 112;
        pixels.data[i + 1] = light ? 242 : 96;
        pixels.data[i + 2] = light ? 249 : 136;
      }
      ctx.putImageData(pixels, 0, 0);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, {source, variant});
  return Buffer.from(data, 'base64');
}

async function upload(page, buffer) {
  await page.locator('#fileInput').setInputFiles({
    name: 'qr.png',
    mimeType: 'image/png',
    buffer
  });
}

async function workerSequence(page, items, query) {
  const encoded = [];
  for (const item of items) {
    encoded.push({
      attempt: item.attempt ?? 0,
      mode: item.mode || 'photo',
      base64: (await qrImage(page, item.text || payload, item.variant || 'plain')).toString('base64')
    });
  }
  return page.evaluate(async ({items, query}) => {
    function decodeBase64(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    async function toImageData(base64) {
      const blob = new Blob([decodeBase64(base64)], {type: 'image/png'});
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    const worker = new Worker(`/qr-worker.js${query}`);
    const pending = new Map();
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    worker.onmessage = ({data: message}) => {
      if (message.type === 'ready') {
        readyResolve(message);
        return;
      }
      if (message.type === 'fatal') {
        readyReject(Error(message.error));
        return;
      }
      if (message.type === 'result') {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          entry.resolve(message);
        }
      }
    };
    worker.onerror = event => {
      const error = Error(event.message || 'Worker error');
      readyReject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    await ready;
    const results = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const image = await toImageData(item.base64);
      const id = index + 1;
      const result = await new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        worker.postMessage({
          type: 'decode',
          id,
          width: image.width,
          height: image.height,
          buffer: image.data.buffer,
          mode: item.mode,
          attempt: item.attempt
        }, [image.data.buffer]);
      });
      results.push(result);
    }
    worker.terminate();
    return results;
  }, {items: encoded, query});
}

for (const {title, variant} of uiVariants) {
  test(`decodes ${title} image locally`, async ({page}) => {
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) &&
        new URL(request.url()).hostname !== '127.0.0.1') {
        external.push(request.url());
      }
    });
    await page.goto('/');
    await upload(page, await qrImage(page, payload, variant));
    await expect(page.locator('#resultText')).toHaveValue(payload);
    await expect(page.locator('#openLink')).toHaveAttribute('href', payload);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}

test('worker preserves decode protocol and returns timing metadata', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Worker metadata checks are validated in Chromium');
  await page.goto('/');
  const [result] = await workerSequence(page, [{variant: 'plain'}], '?v=4&native=off');
  expect(result.type).toBe('result');
  expect(result.id).toBe(1);
  expect(result.text).toBe(payload);
  expect(result.error).toBeFalsy();
  expect(result.engine).toBe('zxing');
  expect(typeof result.timing.totalMs).toBe('number');
  expect(result.timing.totalMs).toBeGreaterThan(0);
  expect(typeof result.timing.zxingMs).toBe('number');
  expect(result.timing.zxingMs).toBeGreaterThan(0);
});

test('worker falls back after native error and disables native for later decodes', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Native fallback checks are validated in Chromium');
  await page.goto('/');
  const results = await workerSequence(page, [
    {variant: 'plain', attempt: 0, mode: 'camera'},
    {variant: 'plain', attempt: 3, mode: 'camera'}
  ], '?v=4&native=error');
  expect(results[0].text).toBe(payload);
  expect(results[0].engine).toBe('zxing');
  expect('nativeMs' in results[0].timing).toBe(true);
  expect(results[1].text).toBe(payload);
  expect(results[1].engine).toBe('zxing');
  expect(results[1].timing.nativeMs ?? 0).toBe(0);
});

test('worker falls back after native hang and disables native for later decodes', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Native timeout checks are validated in Chromium');
  await page.goto('/');
  const results = await workerSequence(page, [
    {variant: 'plain', attempt: 0, mode: 'camera'},
    {variant: 'plain', attempt: 3, mode: 'camera'}
  ], '?v=4&native=hang&nativeTimeoutMs=40');
  expect(results[0].text).toBe(payload);
  expect(results[0].engine).toBe('zxing');
  expect(results[0].timing.nativeMs).toBeGreaterThanOrEqual(35);
  expect(results[1].text).toBe(payload);
  expect(results[1].engine).toBe('zxing');
  expect(results[1].timing.nativeMs ?? 0).toBe(0);
});

test('worker uses jsQR fallback when ZXing has no result', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'jsQR fallback checks are validated in Chromium');
  await page.goto('/');
  const [result] = await workerSequence(page, [{variant: 'plain'}], '?v=4&native=off&zxing=empty');
  expect(result.text).toBe(payload);
  expect(result.error).toBeFalsy();
  expect(result.engine).toBe('jsqr');
  expect(typeof result.timing.jsqrMs).toBe('number');
  expect(result.timing.jsqrMs).toBeGreaterThan(0);
});

test('unsafe content stays text; repeated upload works', async ({page}) => {
  await page.goto('/');
  const text = 'javascript:alert("QR")';
  const buffer = await qrImage(page, text);
  await upload(page, buffer);
  await expect(page.locator('#resultText')).toHaveValue(text);
  await expect(page.locator('#openLink')).toBeHidden();
  await upload(page, buffer);
  await expect(page.locator('#resultText')).toHaveValue(text);
});

test('theme persists and narrow screen does not overflow', async ({page}) => {
  await page.goto('/');
  const before = await page.locator('html').getAttribute('data-theme');
  await page.locator('#themeButton').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme',
    before === 'dark' ? 'light' : 'dark');
  await page.setViewportSize({width: 320, height: 700});
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    };
  });
  await page.goto('/');
  await page.locator('#startButton').click();
  await expect(page.locator('#status')).toHaveAttribute('data-error', 'true');
  await expect(page.locator('#uploadButton')).toBeEnabled();
});

test('camera crop matches square and stops tracks after decode', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Canvas stream simulation is tested in Chromium');
  const source = await QRCode.toDataURL(payload, {
    width: 600,
    margin: 4,
    errorCorrectionLevel: 'H'
  });
  await page.addInitScript(({source}) => {
    navigator.mediaDevices.enumerateDevices = async () => [];
    navigator.mediaDevices.getUserMedia = async () => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const draw = () => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, 1280, 720);
        ctx.drawImage(image, 340, 60, 600, 600);
      };
      draw();
      const stream = canvas.captureStream(12);
      window.testTrack = stream.getVideoTracks()[0];
      const id = setInterval(() => {
        if (window.testTrack.readyState === 'ended') clearInterval(id);
        else draw();
      }, 80);
      return stream;
    };
  }, {source});
  await page.goto('/');
  await page.locator('#startButton').click();
  await expect(page.locator('#resultText')).toHaveValue(payload);
  await expect.poll(() => page.evaluate(() =>
    window.testTrack?.readyState)).toBe('ended');
});

test('cancel ignores late camera permission and stops acquired track', async ({page, browserName}) => {
  test.skip(browserName !== 'chromium', 'Canvas stream simulation is tested in Chromium');
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      window.grantCamera = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 100;
        const stream = canvas.captureStream();
        window.testTrack = stream.getVideoTracks()[0];
        resolve(stream);
      };
    });
  });
  await page.goto('/');
  await page.locator('#startButton').click();
  await expect.poll(() => page.evaluate(() =>
    typeof window.grantCamera)).toBe('function');
  await page.locator('#stopButton').click();
  await page.evaluate(() => window.grantCamera());
  await expect.poll(() => page.evaluate(() =>
    window.testTrack.readyState)).toBe('ended');
  await expect(page.locator('#video')).toBeHidden();
});
