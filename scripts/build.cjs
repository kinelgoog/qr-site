const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const dist = path.resolve('dist');
  await fs.rm(dist, {recursive: true, force: true});
  await fs.mkdir(path.join(dist, 'vendor'), {recursive: true});
  for (const file of ['index.html', 'styles.css', 'app.js', 'qr-worker.js', 'CNAME']) {
    await fs.copyFile(file, path.join(dist, file));
  }
  const source = 'node_modules/zxing-wasm';
  await fs.copyFile(`${source}/dist/iife/reader/index.js`, `${dist}/vendor/zxing-reader.js`);
  await fs.copyFile(`${source}/dist/reader/zxing_reader.wasm`, `${dist}/vendor/zxing_reader.wasm`);
  const wasm = await fs.readFile(`${dist}/vendor/zxing_reader.wasm`);
  if (wasm.subarray(0, 4).toString('hex') !== '0061736d') throw Error('Invalid WASM binary');
  const notices = [
    ['LICENSE-zxing-wasm.txt', 'https://raw.githubusercontent.com/Sec-ant/zxing-wasm/v2.2.1/LICENSE'],
    ['LICENSE-zxing-cpp.txt', 'https://raw.githubusercontent.com/zxing-cpp/zxing-cpp/v2.3.0/LICENSE'],
    ['LICENSE-zint.txt', 'https://raw.githubusercontent.com/zint/zint/2.13.0/LICENSE']
  ];
  for (const [name, url] of notices) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(`License download failed: ${url} (${response.status})`);
    const text = await response.text();
    if (text.length < 100 || /<html/i.test(text)) throw Error(`Invalid license: ${name}`);
    await fs.writeFile(`${dist}/vendor/${name}`, text);
  }
  await fs.writeFile(`${dist}/vendor/NOTICE.txt`, 'ZXing-WASM 2.2.1 (MIT); ZXing-C++ and ZXingWasm.cpp (Apache-2.0); Zint (BSD-3-Clause). Reader-only distribution. See accompanying license texts.');
  await fs.writeFile(`${dist}/.nojekyll`, '');
  console.log('Static site ready in dist/');
})().catch(error => { console.error(error); process.exit(1); });
