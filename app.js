'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
    remove(key) { try { localStorage.removeItem(key); } catch {} }
  };
  function announce(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let manualTheme = ['light', 'dark'].includes(storage.get('qr-theme'));
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('themeColor').content = theme === 'dark' ? '#101010' : '#f4f3ef';
    $('themeButton').textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    $('themeButton').setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
  }
  setTheme(document.documentElement.dataset.theme || 'light');
  $('themeButton').onclick = () => { manualTheme = true; const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; storage.set('qr-theme', next); setTheme(next); };
  const followTheme = event => { if (!manualTheme) setTheme(event.matches ? 'dark' : 'light'); };
  if (systemTheme.addEventListener) systemTheme.addEventListener('change', followTheme); else systemTheme.addListener(followTheme);

  $('startButton').disabled = $('uploadButton').disabled = true;
  let DecoderClient, Camera;
  try {
    [{DecoderClient}, {Camera}] = await Promise.all([import('./decoder-client.js?v=5'), import('./camera.js?v=5')]);
  } catch {
    announce('Не удалось загрузить сканер. Обнови страницу и проверь соединение.', true); return;
  }
  const video = $('video'), canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {willReadFrequently: true});
  if (!context || !window.Worker || !window.WebAssembly) { announce('Браузер не поддерживает сканер. Попробуй обновить Chrome или Safari.', true); return; }
  const decoder = new DecoderClient(), camera = new Camera(video, storage);
  let state = 'idle', generation = 0, timer = null, attempt = 0;
  let scanStarted = 0, hintShown = false, meanDecode = 90, lastVideoTime = -1;
  let torch = false, torchBusy = false, cancelImage = null, resultVersion = 0;
  const aborted = () => new DOMException('Cancelled', 'AbortError');
  const valid = token => token === generation;
  function setState(next) {
    state = next; document.body.dataset.state = next;
    $('startButton').hidden = next !== 'idle'; $('startButton').disabled = false;
    $('stopButton').hidden = next === 'idle';
    $('stopButton').textContent = next === 'scanning' ? 'Остановить' : 'Отменить';
    $('uploadButton').disabled = next === 'starting' || next === 'image';
    $('uploadButton').textContent = next === 'image' ? 'Распознаём…' : 'Загрузить фото';
    $('cameraSelect').disabled = next !== 'scanning';
    $('preview').setAttribute('aria-busy', String(next === 'starting' || next === 'image'));
  }
  function stopAll() {
    generation++; clearTimeout(timer); timer = null; cancelImage?.(); cancelImage = null;
    camera.stop(); decoder.cancel(); video.hidden = true;
    $('preview').classList.remove('live'); $('placeholder').hidden = false;
    $('placeholderText').textContent = 'Камера включится только с твоего разрешения';
    $('cameraBadge').hidden = true; $('cameraTools').hidden = true;
    torch = false; torchBusy = false; $('torchButton').hidden = true; $('torchButton').disabled = false;
    $('torchButton').setAttribute('aria-pressed', 'false'); $('torchButton').textContent = 'Включить фонарик';
    canvas.width = canvas.height = 1; setState('idle');
  }
  function clearResult() {
    resultVersion++; $('result').hidden = true; $('resultText').value = '';
    $('copyStatus').textContent = ''; $('copyButton').disabled = false;
    $('openLink').hidden = true; $('openLink').removeAttribute('href');
  }
  function showResult(text) {
    stopAll(); resultVersion++; $('resultText').value = text; $('result').hidden = false;
    $('copyStatus').textContent = ''; $('copyButton').disabled = !text;
    let url = null;
    if (/^https?:\/\//i.test(text.trim())) {
      try { const parsed = new URL(text.trim()); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed; } catch {}
    }
    $('openLink').hidden = !url; $('openLink').removeAttribute('href');
    if (url) {
      $('openLink').href = url.href; $('resultType').textContent = 'Ссылка';
      $('resultNote').textContent = `Адрес: ${url.hostname}. Проверь его перед открытием. QR-код не гарантирует безопасность сайта.`;
    } else {
      $('resultType').textContent = text ? 'Текст' : 'Пустой код';
      $('resultNote').textContent = text ? 'Ничего не запускается автоматически. Текст можно скопировать.' : 'QR-код распознан, но текстовых данных в нём нет.';
    }
    document.body.dataset.state = 'success';
    $('placeholderText').textContent = 'Готово. Можно сканировать следующий код';
    announce('QR-код распознан. Камера выключена.');
    $('resultText').focus({preventScroll: true});
    $('result').scrollIntoView({block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }
  function cameraError(error) {
    if (['NotAllowedError', 'PermissionDeniedError'].includes(error.name)) return 'Разреши доступ к камере в настройках сайта или загрузи изображение.';
    if (['NotFoundError', 'DevicesNotFoundError'].includes(error.name)) return 'Камера не найдена. Можно загрузить изображение.';
    if (['NotReadableError', 'TrackStartError'].includes(error.name)) return 'Камера занята или недоступна. Закрой другие приложения с камерой и попробуй снова.';
    return 'Не удалось включить камеру. Попробуй снова или загрузи изображение.';
  }
  async function startCamera(explicit = null) {
    stopAll(); clearResult();
    if (!window.isSecureContext) { announce('Для камеры нужен HTTPS. Открой опубликованный сайт.', true); return; }
    if (!navigator.mediaDevices?.getUserMedia) { announce('Камера недоступна в этом браузере. Открой сайт в Chrome или Safari либо загрузи фото.', true); return; }
    const token = generation; setState('starting'); announce('Подготавливаем сканер.');
    $('placeholderText').textContent = 'Подготавливаем сканер';
    try { await decoder.prepare(); } catch {
      if (!valid(token)) return; stopAll(); announce('Не удалось загрузить распознавание. Обнови страницу и попробуй снова.', true); return;
    }
    if (!valid(token)) return;
    try {
      announce('Разреши доступ к камере, если браузер спросит.');
      const {track, caps, devices} = await camera.open(explicit, () => { stopAll(); announce('Камера отключилась. Включи её снова.'); });
      if (!valid(token)) return;
      $('cameraSelect').replaceChildren();
      devices.forEach((device, index) => { const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Камера ${index + 1}`; $('cameraSelect').append(option); });
      $('cameraSelect').value = track.getSettings().deviceId || '';
      $('cameraChoice').hidden = devices.length < 2; $('torchButton').hidden = caps.torch !== true;
      $('cameraTools').hidden = devices.length < 2 && caps.torch !== true;
      $('placeholder').hidden = true; $('preview').classList.add('live'); $('cameraBadge').hidden = false;
      $('cameraBadge').textContent = 'Ищем QR-код';
      attempt = 0; scanStarted = performance.now(); hintShown = false; meanDecode = 90; lastVideoTime = -1;
      setState('scanning'); announce('Покажи код целиком. Оставь светлое поле вокруг него.');
      void scanFrame(token);
    } catch (error) { if (valid(token)) { stopAll(); announce(cameraError(error), true); } }
  }
  function captureVideo(limit) {
    const width = video.videoWidth, height = video.videoHeight, side = Math.min(width, height);
    const size = Math.max(1, Math.round(Math.min(side, limit)));
    canvas.width = canvas.height = size; context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  }
  async function scanFrame(token) {
    if (!valid(token) || state !== 'scanning') return;
    const started = performance.now();
    try {
      if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        // Keep fine detail periodically, reduce ordinary frame size on slow devices.
        const limit = attempt % 4 === 3 ? 1280 : meanDecode > 180 ? 640 : 900;
        const decoded = await decoder.decode(captureVideo(limit), 'camera', attempt);
        if (!valid(token)) return;
        const elapsed = performance.now() - started;
        meanDecode = meanDecode * 0.7 + elapsed * 0.3;
        if (decoded.text !== null) { showResult(decoded.text); return; }
        attempt++;
        if (!hintShown && performance.now() - scanStarted > 4500) {
          hintShown = true; $('cameraBadge').textContent = 'Продолжаем поиск';
          announce('Чуть отодвинь телефон для фокусировки. Если виден блик, измени угол.');
        }
      }
    } catch {
      if (!valid(token)) return;
      stopAll(); decoder.dispose(); announce('Распознавание прервалось. Включи камеру снова или загрузи фото.', true); return;
    }
    if (!valid(token)) return;
    const elapsed = performance.now() - started;
    // No queued frames. Rest between attempts to leave headroom on older phones.
    const rest = Math.min(180, Math.max(60, meanDecode * 0.55));
    timer = setTimeout(() => void scanFrame(token), Math.max(rest, 190 - elapsed));
  }
  $('startButton').onclick = () => void startCamera();
  $('stopButton').onclick = () => { const image = state === 'image'; stopAll(); announce(image ? 'Обработка отменена.' : 'Камера выключена.'); $('startButton').focus(); };
  $('cameraSelect').onchange = () => { if ($('cameraSelect').value) void startCamera($('cameraSelect').value); };
  $('torchButton').onclick = async () => {
    if (state !== 'scanning' || torchBusy) return;
    const token = generation; torchBusy = true; $('torchButton').disabled = true;
    try {
      const next = await camera.setTorch(!torch); if (!valid(token)) return; torch = next;
      $('torchButton').setAttribute('aria-pressed', String(torch)); $('torchButton').textContent = torch ? 'Выключить фонарик' : 'Включить фонарик';
      announce(torch ? 'Фонарик включён. На глянцевой поверхности он может усилить блик.' : 'Фонарик выключен.');
    } catch { if (valid(token)) announce('Браузер не разрешил переключить фонарик.', true); }
    finally { if (valid(token)) { torchBusy = false; $('torchButton').disabled = false; } }
  };
  $('uploadButton').onclick = () => {
    if (state === 'scanning') { stopAll(); announce('Камера выключена. Выбери изображение.'); }
    $('fileInput').value = ''; $('fileInput').click();
  };
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image(); let settled = false, timeout;
      function finish(error) {
        if (settled) return; settled = true; clearTimeout(timeout); image.onload = image.onerror = null;
        if (cancelImage === cancel) cancelImage = null;
        if (error) { image.src = ''; reject(error); } else resolve(image);
      }
      function cancel() { finish(aborted()); }
      cancelImage = cancel; image.onload = () => finish(); image.onerror = () => finish(Error('FORMAT'));
      timeout = setTimeout(() => finish(Error('IMAGE_TIMEOUT')), 20000); image.src = url;
    });
  }
  function captureImage(image, limit) {
    const width = image.naturalWidth, height = image.naturalHeight, ratio = Math.min(1, limit / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }
  $('fileInput').onchange = async () => {
    const file = $('fileInput').files?.[0]; if (!file) return;
    $('fileInput').value = ''; stopAll(); clearResult();
    if (file.size > 24 * 1024 * 1024) { announce('Выбери файл до 24 МБ или сделай скриншот кода.', true); return; }
    const token = generation; let phase = 'decoder', image, url;
    setState('image'); announce('Подготавливаем распознавание.'); $('placeholderText').textContent = 'Ищем QR-код на изображении';
    try {
      await decoder.prepare(); if (!valid(token)) return;
      phase = 'image'; url = URL.createObjectURL(file); image = await loadImage(url); if (!valid(token)) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height) throw Error('FORMAT'); if (width * height > 40000000) throw Error('SIZE');
      phase = 'decode'; let previous = 0, text = null;
      for (const limit of [1000, 1800, 2600]) {
        const size = Math.min(limit, Math.max(width, height)); if (size === previous) continue; previous = size;
        announce(limit === 1000 ? 'Ищем QR-код. Изображение остаётся на устройстве.' : 'Проверяем другое разрешение и контраст.');
        await new Promise(resolve => setTimeout(resolve, 20)); if (!valid(token)) return;
        const decoded = await decoder.decode(captureImage(image, size), 'photo', 0); if (!valid(token)) return;
        text = decoded.text; if (text !== null) break;
      }
      if (text !== null) showResult(text); else { stopAll(); announce('Код не найден. Обрежь фото ближе к коду, сохрани углы и светлое поле вокруг него.', true); }
    } catch (error) {
      if (!valid(token)) return; stopAll();
      if (phase === 'decoder') announce('Не удалось загрузить распознавание. Обнови страницу.', true);
      else if (error.message === 'SIZE') announce('Слишком высокое разрешение. Уменьши фото или загрузи скриншот.', true);
      else if (phase === 'image') announce('Не удалось открыть фото. Попробуй PNG, JPEG или WebP. HEIC поддерживается не везде.', true);
      else { decoder.dispose(); announce('Обработка прервалась. Уменьши фото или обрежь его ближе к коду.', true); }
    } finally { if (url) URL.revokeObjectURL(url); if (image) image.src = ''; }
  };
  $('copyButton').onclick = async () => {
    const text = $('resultText').value, version = resultVersion; let copied = false; $('copyButton').disabled = true;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch {}
    if (version !== resultVersion) return;
    if (!copied) { $('resultText').focus(); $('resultText').select(); $('resultText').setSelectionRange(0, text.length); try { copied = document.execCommand('copy'); } catch {} }
    $('copyStatus').textContent = copied ? 'Скопировано.' : 'Текст выделен. Выбери «Копировать» в меню устройства.'; $('copyButton').disabled = !text;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state !== 'idle') { const image = state === 'image'; stopAll(); announce(image ? 'Обработка остановлена при смене вкладки. Выбери фото ещё раз.' : 'Камера выключена при смене вкладки. Включи её снова.'); }
  });
  window.addEventListener('pagehide', () => { stopAll(); decoder.dispose(); });
  setState('idle');
  const warmToken = generation;
  void decoder.prepare().catch(error => { if (error.name !== 'AbortError' && valid(warmToken) && state === 'idle') announce('Не удалось подготовить распознавание. Обнови страницу или включи камеру снова.', true); });
})().catch(() => {
  const status = document.getElementById('status');
  status.textContent = 'Не удалось запустить сканер. Обнови страницу или попробуй другой браузер.'; status.dataset.error = 'true';
});
