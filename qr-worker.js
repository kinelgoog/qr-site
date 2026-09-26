'use strict';

const search = new URL(self.location.href).searchParams;
const nativeTestMode = search.get('native') || '';
const forceEmptyZXing = search.get('zxing') === 'empty';
const nativeTimeoutMs = readPositiveNumber('nativeTimeoutMs', 180);

let ready = false;
let busy = false;
let jsQRDecoder = null;
const nativeState = {
  detector: null,
  enabled: false,
  disabledReason: ''
};

installNativeTestMode();

async function initialize() {
  try {
    try {
      importScripts('./vendor/jsQR.js');
      if (typeof self.jsQR === 'function') jsQRDecoder = self.jsQR;
    } catch {}
    importScripts('./vendor/zxing-reader.js');
    await ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile(path, prefix) {
          return path.endsWith('.wasm') ?
            new URL('./vendor/zxing_reader.wasm', self.location.href).href :
            prefix + path;
        }
      },
      fireImmediately: true
    });
    await prepareNativeDetector();
    ready = true;
    self.postMessage({type: 'ready'});
  } catch (error) {
    self.postMessage({type: 'fatal', error: String(error)});
  }
}

function readPositiveNumber(name, fallback) {
  const value = Number(search.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now ===
    'function' ? performance.now() : Date.now();
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function addTiming(timing, key, value) {
  timing[key] = roundMs((timing[key] || 0) + value);
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), timeoutMs);
    })
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function installNativeTestMode() {
  if (nativeTestMode === 'off') {
    try { self.BarcodeDetector = undefined; } catch {}
    return;
  }
  if (nativeTestMode === 'error' || nativeTestMode === 'hang') {
    self.BarcodeDetector = class TestBarcodeDetector {
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        if (nativeTestMode === 'error') throw Error('Native detector test failure');
        return new Promise(() => {});
      }
    };
  }
}

function disableNative(error) {
  nativeState.detector = null;
  nativeState.enabled = false;
  nativeState.disabledReason = String(error);
}

async function prepareNativeDetector() {
  if (nativeTestMode === 'off') return;
  if (typeof self.BarcodeDetector !== 'function') return;
  if (typeof self.BarcodeDetector.getSupportedFormats !== 'function') return;
  try {
    const formats = await withTimeout(
      Promise.resolve(self.BarcodeDetector.getSupportedFormats()),
      1000,
      'Native detector setup timeout'
    );
    if (!Array.isArray(formats) || !formats.includes('qr_code')) return;
    nativeState.detector = new self.BarcodeDetector({formats: ['qr_code']});
    nativeState.enabled = true;
  } catch (error) {
    disableNative(error);
  }
}

async function readWithZXing(image, options, timing) {
  const started = now();
  try {
    if (forceEmptyZXing) return null;
    const results = await ZXingWASM.readBarcodes(image, {
      formats: ['QRCode'],
      maxNumberOfSymbols: 1,
      returnErrors: false,
      textMode: 'Plain',
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: true,
      binarizer: options.global ? 'GlobalHistogram' : 'LocalAverage'
    });
    const found = results.find(item =>
      item.isValid && typeof item.text === 'string');
    return found ? found.text : null;
  } finally {
    addTiming(timing, 'zxingMs', now() - started);
  }
}

async function readWithNative(image, timing) {
  if (!nativeState.enabled || !nativeState.detector) return null;
  const started = now();
  try {
    const results = await withTimeout(
      nativeState.detector.detect(image),
      nativeTimeoutMs,
      'Native detector timeout'
    );
    const found = Array.isArray(results) ?
      results.find(item => typeof item.rawValue === 'string') :
      null;
    return found ? found.rawValue : null;
  } catch (error) {
    disableNative(error);
    return null;
  } finally {
    addTiming(timing, 'nativeMs', now() - started);
  }
}

function readWithJsQR(image, inversionAttempts, timing) {
  if (typeof jsQRDecoder !== 'function') return null;
  const started = now();
  try {
    const limited = limitImage(image, 800);
    const result = jsQRDecoder(limited.data, limited.width, limited.height,
      {inversionAttempts});
    return result && typeof result.data === 'string' ? result.data : null;
  } catch {
    return null;
  } finally {
    addTiming(timing, 'jsqrMs', now() - started);
  }
}

function limitImage(image, maxSide) {
  const {width, height} = image;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return image;
  const scale = maxSide / longest;
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const source = image.data;
  const output = new Uint8ClampedArray(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y++) {
    const sourceY = Math.max(0, Math.min(height - 1,
      Math.round((y + 0.5) / scale - 0.5)));
    for (let x = 0; x < nextWidth; x++) {
      const sourceX = Math.max(0, Math.min(width - 1,
        Math.round((x + 0.5) / scale - 0.5)));
      const from = (sourceY * width + sourceX) * 4;
      const to = (y * nextWidth + x) * 4;
      output[to] = source[from];
      output[to + 1] = source[from + 1];
      output[to + 2] = source[from + 2];
      output[to + 3] = source[from + 3];
    }
  }
  return new ImageData(output, nextWidth, nextHeight);
}

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}

function enhance(image, sharpen) {
  const {width, height, data} = image;
  const count = width * height;
  const gray = new Uint8Array(count);
  const histogram = new Uint32Array(256);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const value = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
    gray[p] = value;
    histogram[value]++;
  }
  const tail = count * 0.015;
  let low = 0;
  let high = 255;
  let sum = 0;
  for (let value = 0; value < 256; value++) {
    sum += histogram[value];
    if (sum >= tail) {
      low = value;
      break;
    }
  }
  sum = 0;
  for (let value = 255; value >= 0; value--) {
    sum += histogram[value];
    if (sum >= tail) {
      high = value;
      break;
    }
  }
  const range = high - low;
  const output = new Uint8ClampedArray(count * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let value = gray[p];
      if (sharpen && x > 0 && y > 0 && x < width - 1 && y < height - 1) {
        value += 0.65 * (value - (gray[p - 1] + gray[p + 1] +
          gray[p - width] + gray[p + width]) / 4);
      }
      if (range > 28) value = (value - low) * 255 / range;
      value = clampByte(value);
      const i = p * 4;
      output[i] = value;
      output[i + 1] = value;
      output[i + 2] = value;
      output[i + 3] = 255;
    }
  }
  return new ImageData(output, width, height);
}

async function decodeCamera(image, attempt, timing) {
  let text = await readWithZXing(image, {global: false}, timing);
  if (text !== null) return {text, engine: 'zxing'};
  const cycle = Math.abs(Number(attempt) || 0) % 6;
  if (cycle === 0 || cycle === 3) {
    text = await readWithNative(image, timing);
    return text !== null ? {text, engine: 'native'} : {text: null, engine: null};
  }
  if (cycle === 1) {
    text = readWithJsQR(image, 'dontInvert', timing);
    return text !== null ? {text, engine: 'jsqr'} : {text: null, engine: null};
  }
  if (cycle === 2) {
    text = await readWithZXing(enhance(image, true), {global: false}, timing);
    return text !== null ? {text, engine: 'zxing'} : {text: null, engine: null};
  }
  if (cycle === 4) {
    text = readWithJsQR(enhance(image, false), 'invertFirst', timing);
    return text !== null ? {text, engine: 'jsqr'} : {text: null, engine: null};
  }
  text = await readWithZXing(enhance(image, true), {global: true}, timing);
  return text !== null ? {text, engine: 'zxing'} : {text: null, engine: null};
}

async function decodePhoto(image, timing) {
  let text = await readWithZXing(image, {global: false}, timing);
  if (text !== null) return {text, engine: 'zxing'};
  text = await readWithNative(image, timing);
  if (text !== null) return {text, engine: 'native'};
  text = readWithJsQR(image, 'attemptBoth', timing);
  if (text !== null) return {text, engine: 'jsqr'};
  const sharpened = enhance(image, true);
  text = await readWithZXing(sharpened, {global: false}, timing);
  if (text !== null) return {text, engine: 'zxing'};
  text = readWithJsQR(sharpened, 'invertFirst', timing);
  if (text !== null) return {text, engine: 'jsqr'};
  text = await readWithZXing(enhance(image, false), {global: true}, timing);
  return text !== null ? {text, engine: 'zxing'} : {text: null, engine: null};
}

self.onmessage = async ({data: message}) => {
  if (message.type !== 'decode') return;
  if (!ready || busy) {
    self.postMessage({
      type: 'result',
      id: message.id,
      text: null,
      error: 'Decoder unavailable'
    });
    return;
  }
  busy = true;
  const timing = {};
  const started = now();
  try {
    const image = new ImageData(new Uint8ClampedArray(message.buffer),
      message.width, message.height);
    const result = message.mode === 'photo' ?
      await decodePhoto(image, timing) :
      await decodeCamera(image, message.attempt, timing);
    timing.totalMs = roundMs(now() - started);
    self.postMessage({
      type: 'result',
      id: message.id,
      text: result.text,
      engine: result.engine || undefined,
      timing
    });
  } catch (error) {
    timing.totalMs = roundMs(now() - started);
    self.postMessage({
      type: 'result',
      id: message.id,
      text: null,
      error: String(error),
      timing
    });
  } finally {
    busy = false;
  }
};

void initialize();
