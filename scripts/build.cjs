const fs = require('node:fs/promises');
const path = require('node:path');

async function copyNotice(source, target) {
  const text = await fs.readFile(source, 'utf8');
  if (text.length < 100 || /<html/i.test(text)) {
    throw Error(`Invalid license: ${path.basename(source)}`);
  }
  await fs.writeFile(target, text);
}

(async () => {
  const dist = path.resolve('dist');
  const vendor = path.join(dist, 'vendor');
  const zxingRoot = path.resolve('node_modules/zxing-wasm');
  await fs.rm(dist, {recursive: true, force: true});
  await fs.mkdir(vendor, {recursive: true});
  for (const file of ['index.html', 'styles.css', 'app.js', 'qr-worker.js', 'CNAME']) {
    await fs.copyFile(file, path.join(dist, file));
  }
  await fs.copyFile(path.resolve('jsQR.js'), path.join(vendor, 'jsQR.js'));
  await fs.copyFile(path.join(zxingRoot, 'dist/iife/reader/index.js'),
    path.join(vendor, 'zxing-reader.js'));
  await fs.copyFile(path.join(zxingRoot, 'dist/reader/zxing_reader.wasm'),
    path.join(vendor, 'zxing_reader.wasm'));
  const wasm = await fs.readFile(path.join(vendor, 'zxing_reader.wasm'));
  if (wasm.subarray(0, 4).toString('hex') !== '0061736d') {
    throw Error('Invalid WASM binary');
  }
  await copyNotice(path.join(zxingRoot, 'LICENSE'),
    path.join(vendor, 'LICENSE-zxing-wasm.txt'));
  await copyNotice(path.resolve('LICENSE-jsQR.txt'),
    path.join(vendor, 'LICENSE-jsQR.txt'));
  await fs.writeFile(path.join(vendor, 'NOTICE.txt'), [
    'Included local decoder assets:',
    '- zxing-reader.js and zxing_reader.wasm from zxing-wasm 2.2.1',
    '  License: LICENSE-zxing-wasm.txt',
    '- jsQR.js optional fallback copied from the repository vendor file',
    '  License: LICENSE-jsQR.txt',
    '',
    'All runtime decoder assets are served from dist/vendor with no network fetches.'
  ].join('\n'));
  await fs.writeFile(path.join(dist, '.nojekyll'), '');
  console.log('Static site ready in dist/');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
