const aborted = () => new DOMException('Cancelled', 'AbortError');
export function capabilities(track) { try { return track.getCapabilities?.() || {}; } catch { return {}; } }
function score(device) {
  const name = device.label.toLowerCase();
  if (/front|user|facetime|перед|фронт|truedepth/.test(name)) return -1000;
  let result = 0;
  if (/back|rear|environment|задн|тыл/.test(name)) result += 30;
  if (/main|основн|standard|обычн/.test(name)) result += 50;
  if (/wide|широк/.test(name)) result += 10;
  if (/ultra|сверх|ультра|0[.,]5/.test(name)) result -= 150;
  if (/tele|телефото|macro|макро|depth|глубин/.test(name)) result -= 120;
  return result;
}
export class Camera {
  constructor(video, storage) { this.video = video; this.storage = storage; this.generation = 0; this.stream = null; this.devices = []; }
  release() { this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; this.video.pause(); this.video.srcObject = null; }
  stop() { this.generation++; this.release(); }
  check(token) { if (token !== this.generation) throw aborted(); }
  async acquire(deviceId, token) {
    const acquired = await navigator.mediaDevices.getUserMedia({audio: false, video: {
      ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: {ideal: 'environment'}}),
      width: {ideal: 1920}, height: {ideal: 1080}, frameRate: {ideal: 24, max: 30}
    }});
    if (token !== this.generation) { acquired.getTracks().forEach(track => track.stop()); throw aborted(); }
    this.stream = acquired;
  }
  async open(explicit, onEnded) {
    this.stop(); const token = this.generation;
    let preferred = explicit || this.storage.get('qr-camera-v2');
    try {
      try { await this.acquire(preferred, token); } catch (error) {
        this.check(token);
        if (preferred && !explicit && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
          this.storage.remove('qr-camera-v2'); preferred = null; await this.acquire(null, token);
        } else throw error;
      }
      let devices = [];
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'videoinput' && x.deviceId); } catch {}
      this.check(token); this.devices = devices;
      if (!preferred) {
        const id = this.stream.getVideoTracks()[0]?.getSettings().deviceId;
        const best = [...devices].sort((a, b) => score(b) - score(a))[0];
        const current = devices.find(x => x.deviceId === id);
        if (best && best.deviceId !== id && score(best) >= 30 && (!current || score(best) > score(current))) {
          this.release();
          try { await this.acquire(best.deviceId, token); } catch { this.check(token); await this.acquire(null, token); }
        }
      }
      this.check(token);
      const track = this.stream.getVideoTracks()[0]; if (!track) throw Error('No camera track');
      const caps = capabilities(track), changes = [];
      if (caps.focusMode?.includes('continuous')) changes.push({focusMode: 'continuous'});
      // Baseline zoom does not identify the physical 1x lens.
      if (caps.zoom && caps.zoom.min <= 1 && caps.zoom.max >= 1) changes.push({zoom: 1});
      for (const change of changes) { this.check(token); try { await track.applyConstraints({advanced: [change]}); } catch {} }
      this.check(token);
      track.addEventListener('ended', () => { if (token === this.generation) onEnded(); }, {once: true});
      this.video.srcObject = this.stream; this.video.hidden = false; this.video.muted = true;
      await this.video.play(); this.check(token);
      if (explicit) this.storage.set('qr-camera-v2', track.getSettings().deviceId || explicit);
      return {track, caps, devices};
    } catch (error) { if (token === this.generation) this.stop(); throw error; }
  }
  async setTorch(value) {
    const track = this.stream?.getVideoTracks()[0]; if (!track) throw aborted();
    const token = this.generation;
    await track.applyConstraints({advanced: [{torch: value}]}); this.check(token);
    return typeof track.getSettings().torch === 'boolean' ? track.getSettings().torch : value;
  }
}
