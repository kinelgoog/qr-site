// One outstanding frame, transferable pixels, and explicit cancellation.
export class DecoderClient {
  constructor() { this.worker = null; this.ready = false; this.loading = null; this.boot = null; this.job = null; this.nextId = 0; }
  dispose(error = new DOMException('Cancelled', 'AbortError')) {
    this.worker?.terminate(); this.worker = null; this.ready = false; this.loading = null;
    if (this.boot) { clearTimeout(this.boot.timer); this.boot.reject(error); this.boot = null; }
    if (this.job) { clearTimeout(this.job.timer); this.job.reject(error); this.job = null; }
  }
  cancel() { if (this.job || this.boot) this.dispose(); }
  prepare() {
    if (this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    const promise = new Promise((resolve, reject) => {
      this.boot = {resolve, reject, timer: setTimeout(() => this.dispose(Error('Decoder load timeout')), 30000)};
    });
    this.loading = promise;
    try {
      const current = new Worker(new URL('./qr-worker.js?v=5', import.meta.url)); this.worker = current;
      current.onmessage = ({data}) => {
        if (this.worker !== current) return;
        if (data.type === 'ready') {
          this.ready = true;
          const boot = this.boot; this.boot = null;
          if (boot) { clearTimeout(boot.timer); boot.resolve(); }
        } else if (data.type === 'fatal') this.dispose(Error(data.error));
        else if (data.type === 'result' && data.id === this.job?.id) {
          const job = this.job; this.job = null; clearTimeout(job.timer);
          if (data.error) job.reject(Error(data.error));
          else job.resolve({text: data.text ?? null, timing: data.timing || {}, engine: data.engine});
        }
      };
      current.onerror = event => { event.preventDefault(); if (this.worker === current) this.dispose(Error('Worker failed')); };
      current.onmessageerror = () => { if (this.worker === current) this.dispose(Error('Worker message failed')); };
    } catch (error) { this.dispose(error); }
    return promise;
  }
  decode(image, mode, attempt) {
    if (!this.ready || !this.worker || this.job) return Promise.reject(Error('Decoder unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { if (this.job?.id === id) this.dispose(Error('Decode timeout')); }, mode === 'photo' ? 30000 : 12000);
      this.job = {id, timer, resolve, reject};
      try {
        this.worker.postMessage({type: 'decode', id, width: image.width, height: image.height, buffer: image.data.buffer, mode, attempt}, [image.data.buffer]);
      } catch (error) { clearTimeout(timer); this.job = null; reject(error); }
    });
  }
}
