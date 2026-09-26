'use strict';
let ready = false;
let busy = false;
async function initialize() {
  try {
    importScripts('./vendor/zxing-reader.js');
    await ZXingWASM.prepareZXingModule({
      overrides: { locateFile(path, prefix) {
        return path.endsWith('.wasm') ? new URL('./vendor/zxing_reader.wasm', self.location.href).href : prefix + path;
      } },
      fireImmediately: true
    });
    ready = true;
    self.postMessage({type: 'ready'});
  } catch (error) { self.postMessage({type: 'fatal', error: String(error)}); }
}
async function read(image, hard, global = false) {
  const results = await ZXingWASM.readBarcodes(image, {
    formats: ['QRCode'], maxNumberOfSymbols: 1, returnErrors: false,
    textMode: 'Plain', tryHarder: hard, tryRotate: true,
    tryInvert: true, tryDownscale: true,
    binarizer: global ? 'GlobalHistogram' : 'LocalAverage'
  });
  const found = results.find(item => item.isValid && typeof item.text === 'string');
  return found ? found.text : null;
}
function enhance(image, sharpen) {
  const {width, height, data} = image;
  const count = width * height;
  const gray = new Uint8Array(count);
  const histogram = new Uint32Array(256);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    const value = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
    gray[p] = value; histogram[value]++;
  }
  const tail = count * 0.015;
  let low = 0, high = 255, sum = 0;
  for (let v = 0; v < 256; v++) { sum += histogram[v]; if (sum >= tail) { low = v; break; } }
  sum = 0;
  for (let v = 255; v >= 0; v--) { sum += histogram[v]; if (sum >= tail) { high = v; break; } }
  const range = high - low;
  const output = new Uint8ClampedArray(count * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let value = gray[p];
      if (sharpen && x > 0 && y > 0 && x < width - 1 && y < height - 1) {
        value += 0.65 * (value - (gray[p - 1] + gray[p + 1] + gray[p - width] + gray[p + width]) / 4);
      }
      if (range > 28) value = (value - low) * 255 / range;
      const i = p * 4;
      output[i] = output[i + 1] = output[i + 2] = value;
      output[i + 3] = 255;
    }
  }
  return new ImageData(output, width, height);
}
self.onmessage = async ({data: message}) => {
  if (message.type !== 'decode') return;
  if (!ready || busy) { self.postMessage({type: 'result', id: message.id, error: 'Decoder unavailable'}); return; }
  busy = true;
  try {
    const image = new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height);
    const photo = message.mode === 'photo';
    let text = await read(image, photo || message.attempt % 3 === 2);
    if (text === null && (photo || message.attempt % 6 === 5)) {
      text = await read(enhance(image, photo || message.attempt % 12 === 11), true);
      if (text === null && photo) text = await read(image, true, true);
    }
    self.postMessage({type: 'result', id: message.id, text});
  } catch (error) { self.postMessage({type: 'result', id: message.id, error: String(error)}); }
  finally { busy = false; }
};
void initialize();
