const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const dist = path.resolve('dist');
  await fs.rm(dist, {recursive: true, force: true});
  await fs.mkdir(path.join(dist, 'vendor'), {recursive: true});
  for (const file of ['index.html', 'styles.css', 'app.js', 'decoder-client.js', 'camera.js', 'qr-worker.js', 'CNAME']) await fs.copyFile(file, path.join(dist, file));
  const root = 'node_modules/zxing-wasm';
  await fs.copyFile(`${root}/dist/iife/reader/index.js`, `${dist}/vendor/zxing-reader.js`);
  await fs.copyFile(`${root}/dist/reader/zxing_reader.wasm`, `${dist}/vendor/zxing_reader.wasm`);
  await fs.copyFile('jsQR.js', `${dist}/vendor/jsQR.js`);
  await fs.copyFile('LICENSE-jsQR.txt', `${dist}/vendor/LICENSE-jsQR.txt`);
  await fs.copyFile(`${root}/LICENSE`, `${dist}/vendor/LICENSE-zxing-wasm.txt`);
  const wasm = await fs.readFile(`${dist}/vendor/zxing_reader.wasm`);
  if (wasm.subarray(0, 4).toString('hex') !== '0061736d') throw Error('Invalid WASM binary');
  for (const [name, url] of [
    ['LICENSE-zxing-cpp.txt', 'https://raw.githubusercontent.com/zxing-cpp/zxing-cpp/v2.3.0/LICENSE'],
    ['LICENSE-zint.txt', 'https://raw.githubusercontent.com/zint/zint/2.13.0/LICENSE']
  ]) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(`License download failed: ${name}`);
    const text = await response.text();
    if (text.length < 100 || /<html/i.test(text)) throw Error(`Invalid license: ${name}`);
    await fs.writeFile(`${dist}/vendor/${name}`, text);
  }
  await fs.writeFile(`${dist}/vendor/NOTICE.txt`, 'ZXing-WASM 2.2.1: MIT wrapper; ZXing-C++ and ZXingWasm.cpp: Apache-2.0. Zint: BSD-3-Clause (license included conservatively; reader-only build). jsQR: Apache-2.0. All runtime assets are hosted on the site; no images are uploaded.');
  await fs.writeFile(`${dist}/.nojekyll`, '');
  console.log('Static site ready in dist/');
})().catch(error => {console.error(error); process.exit(1);});
