'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const video = $('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', {willReadFrequently: true});
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
    remove(key) { try { localStorage.removeItem(key); } catch {} }
  };
  let state = 'idle', generation = 0, stream = null, timer = null;
  let attempt = 0, scanStarted = 0, hintShown = false;
  let resultVersion = 0, cancelImage = null, torch = false, torchBusy = false;
  let worker = null, ready = false, loading = null, bootResolve = null, bootReject = null, bootTimer = null;
  let job = null, nextJob = 0;
  const aborted = () => new DOMException('Cancelled', 'AbortError');

  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let manualTheme = ['light', 'dark'].includes(storage.get('qr-theme'));
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('themeColor').content = theme === 'dark' ? '#17131f' : '#f7f5fb';
    $('themeButton').textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    $('themeButton').setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
  }
  setTheme(document.documentElement.dataset.theme || 'light');
  $('themeButton').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    manualTheme = true; storage.set('qr-theme', theme); setTheme(theme);
  };
  const followTheme = event => { if (!manualTheme) setTheme(event.matches ? 'dark' : 'light'); };
  if (systemTheme.addEventListener) systemTheme.addEventListener('change', followTheme);
  else if (systemTheme.addListener) systemTheme.addListener(followTheme);

  function announce(text, error = false) {
    $('status').textContent = text; $('status').dataset.error = String(error);
  }
  function setState(next) {
    state = next;
    $('startButton').hidden = next !== 'idle';
    $('stopButton').hidden = next === 'idle';
    $('stopButton').textContent = next === 'scanning' ? 'Остановить' : 'Отменить';
    $('uploadButton').disabled = next === 'starting' || next === 'image';
    $('uploadButton').textContent = next === 'image' ? 'Распознаём…' : 'Загрузить фото';
    $('cameraSelect').disabled = next !== 'scanning';
    $('preview').setAttribute('aria-busy', String(next === 'starting' || next === 'image'));
  }
  function destroyDecoder(error = aborted()) {
    worker?.terminate(); worker = null; ready = false; clearTimeout(bootTimer);
    bootReject?.(error); bootResolve = null; bootReject = null; loading = null;
    if (job) { const old = job; job = null; clearTimeout(old.timer); old.reject(error); }
  }
  function prepare() {
    if (ready) return Promise.resolve();
    if (loading) return loading;
    const promise = new Promise((resolve, reject) => { bootResolve = resolve; bootReject = reject; });
    loading = promise;
    try {
      if (!context || !window.Worker || !window.WebAssembly) throw Error('Unsupported browser');
      const current = new Worker('./qr-worker.js?v=4'); worker = current;
      bootTimer = setTimeout(() => { if (worker === current) destroyDecoder(Error('Decoder load timeout')); }, 30000);
      current.onmessage = ({data: message}) => {
        if (worker !== current) return;
        if (message.type === 'ready') {
          ready = true; clearTimeout(bootTimer);
          const resolve = bootResolve; bootResolve = null; bootReject = null; resolve?.();
        } else if (message.type === 'fatal') {
          destroyDecoder(Error(message.error));
        } else if (message.type === 'result' && job?.id === message.id) {
          const old = job; job = null; clearTimeout(old.timer);
          if (message.error) old.reject(Error(message.error)); else old.resolve(message.text ?? null);
        }
      };
      current.onerror = event => { event.preventDefault(); if (worker === current) destroyDecoder(Error('Worker failed')); };
      current.onmessageerror = () => { if (worker === current) destroyDecoder(Error('Worker message failed')); };
    } catch (error) { destroyDecoder(error); }
    return promise;
  }
  function decode(image, mode, number) {
    if (!ready || !worker || job) return Promise.reject(Error('Decoder unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++nextJob;
      const timeout = setTimeout(() => { if (job?.id === id) destroyDecoder(Error('Decode timeout')); }, mode === 'photo' ? 30000 : 15000);
      job = {id, resolve, reject, timer: timeout};
      try {
        worker.postMessage({type: 'decode', id, width: image.width, height: image.height, buffer: image.data.buffer, mode, attempt: number}, [image.data.buffer]);
      } catch (error) { clearTimeout(timeout); job = null; reject(error); }
    });
  }
  function releaseStream() {
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    video.pause(); video.srcObject = null;
  }
  function stopAll() {
    generation++; clearTimeout(timer); timer = null;
    cancelImage?.(); cancelImage = null; releaseStream();
    if (job) destroyDecoder();
    video.hidden = true; $('preview').classList.remove('live');
    $('placeholder').hidden = false;
    $('placeholderText').textContent = 'Камера включится только с твоего разрешения';
    $('cameraBadge').hidden = true; $('cameraTools').hidden = true;
    torch = false; torchBusy = false; $('torchButton').hidden = true;
    $('torchButton').disabled = false; $('torchButton').setAttribute('aria-pressed', 'false');
    $('torchButton').textContent = 'Включить фонарик';
    canvas.width = canvas.height = 1; setState('idle');
  }
  function clearResult() {
    resultVersion++; $('result').hidden = true; $('resultText').value = '';
    $('copyStatus').textContent = ''; $('copyButton').disabled = false;
    $('openLink').hidden = true; $('openLink').removeAttribute('href');
  }
  function showResult(text) {
    stopAll(); resultVersion++; $('resultText').value = text; $('result').hidden = false;
    $('copyStatus').textContent = ''; $('copyButton').disabled = text.length === 0;
    let url = null;
    if (/^https?:\/\//i.test(text.trim())) {
      try {
        const parsed = new URL(text.trim());
        if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed;
      } catch {}
    }
    $('openLink').hidden = !url; $('openLink').removeAttribute('href');
    if (url) {
      $('openLink').href = url.href; $('resultType').textContent = 'Ссылка';
      $('resultNote').textContent = `Адрес: ${url.hostname}. Проверь его перед открытием. QR-код не гарантирует безопасность сайта.`;
    } else {
      $('resultType').textContent = text ? 'Текст' : 'Пустой код';
      $('resultNote').textContent = text ? 'Ничего не запускается автоматически. Текст можно скопировать.' : 'QR-код распознан, но текстовых данных в нём нет.';
    }
    $('placeholderText').textContent = 'Готово. Можно сканировать следующий код';
    announce('QR-код распознан. Камера выключена.');
    $('resultText').focus({preventScroll: true});
    $('result').scrollIntoView({block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }
  function capabilities(track) { try { return track.getCapabilities?.() || {}; } catch { return {}; } }
  async function listCameras() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput' && device.deviceId); }
    catch { return []; }
  }
  function scoreCamera(device) {
    const label = device.label.toLowerCase();
    if (/front|user|facetime|перед|фронт|truedepth/.test(label)) return -1000;
    let score = 0;
    if (/back|rear|environment|задн|тыл/.test(label)) score += 30;
    if (/main|основн|standard|обычн/.test(label)) score += 50;
    if (/wide|широк/.test(label)) score += 10;
    if (/ultra|сверх|ультра|0[.,]5/.test(label)) score -= 150;
    if (/tele|телефото|macro|макро|depth|глубин/.test(label)) score -= 120;
    return score;
  }
  async function acquireCamera(deviceId, token) {
    const acquired = await navigator.mediaDevices.getUserMedia({audio: false, video: {
      ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: {ideal: 'environment'}}),
      width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 24, max: 30}
    }});
    if (token !== generation) { acquired.getTracks().forEach(track => track.stop()); throw aborted(); }
    return acquired;
  }
  function cameraError(error) {
    if (['NotAllowedError', 'PermissionDeniedError'].includes(error.name)) return 'Разреши доступ к камере в настройках сайта или загрузи изображение.';
    if (['NotFoundError', 'DevicesNotFoundError'].includes(error.name)) return 'Камера не найдена. Можно загрузить изображение.';
    if (['NotReadableError', 'TrackStartError'].includes(error.name)) return 'Камера недоступна. Закрой другие приложения, использующие её, и попробуй снова.';
    return 'Не удалось запустить камеру. Попробуй снова или загрузи изображение.';
  }
  async function startCamera(explicit = null) {
    stopAll(); clearResult();
    if (!window.isSecureContext) { announce('Для камеры нужен HTTPS. Открой опубликованный сайт.', true); return; }
    if (!navigator.mediaDevices?.getUserMedia) { announce('Камера недоступна в этом браузере. Открой сайт в Chrome или Safari либо загрузи фото.', true); return; }
    const token = generation; setState('starting');
    $('placeholderText').textContent = 'Подготавливаем сканер'; announce('Подготавливаем распознавание.');
    try { await prepare(); } catch {
      if (token !== generation) return;
      stopAll(); announce('Не удалось загрузить распознавание. Обнови страницу и попробуй снова.', true); return;
    }
    if (token !== generation) return;
    let preferred = explicit || storage.get('qr-camera-v2');
    try {
      announce('Разреши доступ к камере, если браузер спросит.');
      try { stream = await acquireCamera(preferred, token); } catch (error) {
        if (token !== generation) return;
        if (preferred && !explicit && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
          storage.remove('qr-camera-v2'); preferred = null; stream = await acquireCamera(null, token);
        } else throw error;
      }
      const devices = await listCameras(); if (token !== generation) return;
      if (!preferred) {
        const active = stream.getVideoTracks()[0]?.getSettings().deviceId;
        const ranked = [...devices].sort((a, b) => scoreCamera(b) - scoreCamera(a));
        const best = ranked[0]; const current = devices.find(device => device.deviceId === active);
        if (best && best.deviceId !== active && scoreCamera(best) >= 30 && (!current || scoreCamera(best) > scoreCamera(current))) {
          releaseStream();
          try { stream = await acquireCamera(best.deviceId, token); } catch {
            if (token !== generation) return;
            stream = await acquireCamera(null, token);
          }
        }
      }
      if (token !== generation) return;
      const track = stream.getVideoTracks()[0];
      if (!track) throw Error('No video track');
      const caps = capabilities(track); const changes = [];
      if (caps.focusMode?.includes('continuous')) changes.push({focusMode: 'continuous'});
      // Zoom is relative to the selected track, not a physical lens guarantee.
      if (caps.zoom && caps.zoom.min <= 1 && caps.zoom.max >= 1) changes.push({zoom: 1});
      for (const change of changes) {
        if (token !== generation) return;
        try { await track.applyConstraints({advanced: [change]}); } catch {}
      }
      if (token !== generation) return;
      track.addEventListener('ended', () => {
        if (token !== generation) return;
        stopAll(); announce('Камера отключилась. Включи её снова.');
      }, {once: true});
      video.srcObject = stream; video.hidden = false; video.muted = true;
      await video.play(); if (token !== generation) return;
      if (explicit) storage.set('qr-camera-v2', track.getSettings().deviceId || explicit);
      $('cameraSelect').replaceChildren();
      devices.forEach((device, index) => {
        const option = document.createElement('option'); option.value = device.deviceId;
        option.textContent = device.label || `Камера ${index + 1}`; $('cameraSelect').append(option);
      });
      $('cameraSelect').value = track.getSettings().deviceId || '';
      $('cameraChoice').hidden = devices.length < 2;
      $('torchButton').hidden = caps.torch !== true;
      $('cameraTools').hidden = devices.length < 2 && caps.torch !== true;
      $('placeholder').hidden = true; $('preview').classList.add('live');
      $('cameraBadge').hidden = false; $('cameraBadge').textContent = 'Ищем QR-код';
      attempt = 0; scanStarted = performance.now(); hintShown = false; setState('scanning');
      announce('Держи код целиком в квадрате. Оставь немного свободного места вокруг него.');
      void scanFrame(token);
    } catch (error) {
      if (token !== generation) return;
      stopAll(); announce(cameraError(error), true);
    }
  }
  function captureVideo(limit) {
    const width = video.videoWidth, height = video.videoHeight;
    const side = Math.min(width, height), size = Math.max(1, Math.round(Math.min(side, limit)));
    canvas.width = canvas.height = size;
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(video, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  }
  async function scanFrame(token) {
    if (token !== generation || state !== 'scanning') return;
    const began = performance.now();
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        const text = await decode(captureVideo(attempt % 3 === 2 ? 1440 : 900), 'camera', attempt);
        if (token !== generation) return;
        if (text !== null) { showResult(text); return; }
        attempt++;
        if (!hintShown && performance.now() - scanStarted > 4500) {
          hintShown = true; $('cameraBadge').textContent = 'Продолжаем поиск';
          announce('Чуть измени угол, убери блик или отодвинь телефон для фокусировки.');
        }
      }
    } catch {
      if (token !== generation) return;
      stopAll(); destroyDecoder(); announce('Распознавание прервалось. Включи камеру снова или загрузи фото.', true); return;
    }
    if (token !== generation) return;
    timer = setTimeout(() => void scanFrame(token), Math.max(45, 180 - (performance.now() - began)));
  }
  $('startButton').onclick = () => void startCamera();
  $('stopButton').onclick = () => {
    const image = state === 'image'; stopAll(); announce(image ? 'Обработка отменена.' : 'Камера выключена.'); $('startButton').focus();
  };
  $('cameraSelect').onchange = () => { if ($('cameraSelect').value) void startCamera($('cameraSelect').value); };
  $('torchButton').onclick = async () => {
    if (state !== 'scanning' || torchBusy || !stream) return;
    const token = generation, track = stream.getVideoTracks()[0], next = !torch;
    torchBusy = true; $('torchButton').disabled = true;
    try {
      await track.applyConstraints({advanced: [{torch: next}]}); if (token !== generation) return;
      const actual = track.getSettings().torch; torch = typeof actual === 'boolean' ? actual : next;
      $('torchButton').setAttribute('aria-pressed', String(torch));
      $('torchButton').textContent = torch ? 'Выключить фонарик' : 'Включить фонарик';
      announce(torch ? 'Фонарик включён. На глянцевой поверхности он может усилить блик.' : 'Фонарик выключен.');
    } catch { if (token === generation) announce('Браузер не разрешил переключить фонарик.', true); }
    finally { if (token === generation) { torchBusy = false; $('torchButton').disabled = false; } }
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
      timeout = setTimeout(() => finish(Error('TIMEOUT')), 20000); image.src = url;
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
    const token = generation; let url, image, phase = 'decoder';
    setState('image'); announce('Подготавливаем распознавание.'); $('placeholderText').textContent = 'Ищем QR-код на изображении';
    try {
      await prepare(); if (token !== generation) return;
      phase = 'image'; url = URL.createObjectURL(file); image = await loadImage(url); if (token !== generation) return;
      const width = image.naturalWidth, height = image.naturalHeight;
      if (!width || !height) throw Error('FORMAT'); if (width * height > 40000000) throw Error('SIZE');
      phase = 'decode'; let previous = 0, text = null;
      for (const limit of [1000, 1800, 2600]) {
        const size = Math.min(limit, Math.max(width, height)); if (size === previous) continue; previous = size;
        announce(limit === 1000 ? 'Ищем QR-код. Изображение остаётся на устройстве.' : 'Проверяем другое разрешение и контраст.');
        await new Promise(resolve => setTimeout(resolve, 20)); if (token !== generation) return;
        text = await decode(captureImage(image, size), 'photo', 0); if (token !== generation) return;
        if (text !== null) break;
      }
      if (text !== null) showResult(text);
      else { stopAll(); announce('Код не найден. Обрежь фото ближе к коду, сохрани углы и светлое поле вокруг него.', true); }
    } catch (error) {
      if (token !== generation) return; stopAll();
      if (phase === 'decoder') announce('Не удалось загрузить распознавание. Обнови страницу.', true);
      else if (error.message === 'SIZE') announce('Слишком высокое разрешение. Уменьши фото или загрузи скриншот.', true);
      else if (phase === 'image') announce('Не удалось открыть фото. Попробуй PNG, JPEG или WebP. HEIC поддерживается не везде.', true);
      else { destroyDecoder(); announce('Обработка прервалась. Уменьши фото или обрежь его ближе к коду.', true); }
    } finally { if (url) URL.revokeObjectURL(url); if (image) image.src = ''; }
  };
  $('copyButton').onclick = async () => {
    const text = $('resultText').value, version = resultVersion; let copied = false; $('copyButton').disabled = true;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch {}
    if (version !== resultVersion) return;
    if (!copied) {
      $('resultText').focus(); $('resultText').select(); $('resultText').setSelectionRange(0, text.length);
      try { copied = document.execCommand('copy'); } catch {}
    }
    $('copyStatus').textContent = copied ? 'Скопировано.' : 'Текст выделен. Выбери «Копировать» в меню устройства.';
    $('copyButton').disabled = !text;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state !== 'idle') {
      const image = state === 'image'; stopAll();
      announce(image ? 'Обработка остановлена при смене вкладки. Выбери фото ещё раз.' : 'Камера выключена при смене вкладки. Включи её снова.');
    }
  });
  window.addEventListener('pagehide', () => { stopAll(); destroyDecoder(); });
  setState('idle');
  void prepare().catch(() => { if (state === 'idle') announce('Не удалось подготовить распознавание. Обнови страницу или попробуй включить камеру снова.', true); });
})();
