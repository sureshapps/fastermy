/*
  FasterNET — a small, dependency-free internet speed test.
  Measures latency, download and upload throughput against
  Cloudflare's public, CORS-enabled speed test endpoints.
*/

const CF_DOWN = (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`;
const CF_UP = 'https://speed.cloudflare.com/__up';
const IP_INFO = 'https://ipwho.is/';
const DOWN_CHUNK = 4 * 1024 * 1024; // 4MB per streamed request
const UP_CHUNK = 2 * 1024 * 1024; // 2MB per upload request
const CONFIG_KEY = 'fasternet-config';
const AUTOSTART_DELAY_MS = 2000;

const DEFAULT_SETTINGS = {
  connMin: 1,
  connMax: 8,
  durMin: 5,
  durMax: 30,
  loadedUpload: false,
  alwaysShow: false,
  saveConfig: false,
};

let settings = { ...DEFAULT_SETTINGS };

const els = {
  ring: document.getElementById('ringProgress'),
  phaseLabel: document.getElementById('phaseLabel'),
  mainNumber: document.getElementById('mainNumber'),
  mainUnit: document.getElementById('mainUnit'),
  controlBtn: document.getElementById('controlBtn'),
  iconPlay: document.getElementById('iconPlay'),
  iconPause: document.getElementById('iconPause'),
  iconRedo: document.getElementById('iconRedo'),
  steps: document.getElementById('steps'),
  details: document.getElementById('details'),
  latUnloaded: document.getElementById('latUnloaded'),
  latLoaded: document.getElementById('latLoaded'),
  uploadSpeed: document.getElementById('uploadSpeed'),
  clientMeta: document.getElementById('clientMeta'),
  serverMeta: document.getElementById('serverMeta'),
  downloadTotal: document.getElementById('downloadTotal'),
  uploadTotal: document.getElementById('uploadTotal'),
  homeBtn: document.getElementById('homeBtn'),
  aboutBtn: document.getElementById('aboutBtn'),
  faqModal: document.getElementById('faqModal'),
  faqClose: document.getElementById('faqClose'),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 96;
els.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

let state = 'idle'; // idle | running | done | error
let abortCtl = null;
let displayedNumber = 0;
let animFrame = null;
let autoStartTimer = null;

// ---------------- settings persistence ----------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS };
  }
}

// ---------------- helpers ----------------

function setRing(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  els.ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
}

function setStep(name) {
  [...els.steps.children].forEach((el) => {
    el.classList.remove('is-active', 'is-done');
    const order = ['latency', 'download', 'upload'];
    if (el.dataset.step === name) el.classList.add('is-active');
    else if (order.indexOf(el.dataset.step) < order.indexOf(name)) el.classList.add('is-done');
  });
}

function markAllStepsDone() {
  [...els.steps.children].forEach((el) => {
    el.classList.remove('is-active');
    el.classList.add('is-done');
  });
}

function animateNumberTo(target, opts = {}) {
  const duration = opts.duration ?? 400;
  const start = displayedNumber;
  const startTime = performance.now();
  if (animFrame) cancelAnimationFrame(animFrame);

  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    displayedNumber = start + (target - start) * eased;
    els.mainNumber.textContent = formatSpeed(displayedNumber);
    if (t < 1) {
      animFrame = requestAnimationFrame(tick);
    } else {
      displayedNumber = target;
    }
  }
  animFrame = requestAnimationFrame(tick);
}

function formatSpeed(v) {
  if (v >= 100) return Math.round(v).toString();
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatMB(bytes) {
  return (bytes / 1_000_000).toFixed(1) + 'MB';
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bytesToMbps(bytes, seconds) {
  if (seconds <= 0) return 0;
  return (bytes * 8) / seconds / 1_000_000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkAbort(signal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

// ---------------- test phases ----------------

async function pingOnce(signal) {
  const t0 = performance.now();
  await fetch(CF_DOWN(0), { cache: 'no-store', signal });
  return performance.now() - t0;
}

async function measureUnloadedLatency(signal) {
  const samples = [];
  for (let i = 0; i < 8; i++) {
    try {
      samples.push(await pingOnce(signal));
    } catch (_) {
      /* ignore a dropped sample */
    }
  }
  if (!samples.length) throw new Error('latency-failed');
  return median(samples);
}

function pingLoop(signal, isStoppedFn, out) {
  return (async () => {
    while (!isStoppedFn()) {
      try {
        out.push(await pingOnce(signal));
      } catch (_) { /* saturated link; skip sample */ }
      await sleep(400);
    }
  })();
}

/**
 * Adaptive, duration-bounded transfer: ramps parallel connections from
 * connMin up to connMax, and stops once the measurement stabilizes after
 * durMin seconds (or unconditionally at durMax seconds).
 */
async function runAdaptiveTransfer({ cfg, signal, onProgress, doRequest }) {
  let stop = false;
  let totalBytes = 0;
  const start = performance.now();
  let targetWorkers = cfg.connMin;
  const samples = [];
  let lastSampleTime = start;
  let lastSampleBytes = 0;

  function addBytes(n) {
    totalBytes += n;
  }

  function recordSample(force) {
    const now = performance.now();
    if (!force && now - lastSampleTime < 200) return;
    const windowBytes = totalBytes - lastSampleBytes;
    const dt = (now - lastSampleTime) / 1000;
    const instMbps = bytesToMbps(windowBytes, dt);
    if (instMbps > 0) {
      samples.push(instMbps);
      if (samples.length > 6) samples.shift();
    }
    const overall = bytesToMbps(totalBytes, (now - start) / 1000);
    onProgress(overall || instMbps, totalBytes);
    lastSampleTime = now;
    lastSampleBytes = totalBytes;
  }

  function stabilized() {
    if (samples.length < 5) return false;
    const recent = samples.slice(-5);
    const mx = Math.max(...recent);
    const mn = Math.min(...recent);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return avg > 0 && (mx - mn) / avg < 0.12;
  }

  const rampTimer = setInterval(() => {
    if (targetWorkers < cfg.connMax) targetWorkers++;
  }, 1000);

  const workers = [];
  async function worker() {
    while (!stop) {
      try {
        await doRequest(signal, addBytes, () => stop);
        recordSample(false);
      } catch (e) {
        if (signal.aborted) return;
        await sleep(200);
      }
    }
  }
  function maybeSpawn() {
    while (workers.length < targetWorkers && !stop) {
      workers.push(worker());
    }
  }
  const spawnTimer = setInterval(maybeSpawn, 300);
  maybeSpawn();

  while (true) {
    await sleep(250);
    recordSample(false);
    const elapsed = (performance.now() - start) / 1000;
    if (signal.aborted) break;
    if (elapsed >= cfg.durMax) break;
    if (elapsed >= cfg.durMin && stabilized()) break;
  }
  stop = true;
  clearInterval(rampTimer);
  clearInterval(spawnTimer);
  await Promise.all(workers);
  recordSample(true);
  const elapsed = (performance.now() - start) / 1000;
  return { mbps: bytesToMbps(totalBytes, elapsed), totalBytes };
}

function measureDownload(cfg, signal, onProgress) {
  return runAdaptiveTransfer({
    cfg,
    signal,
    onProgress,
    doRequest: async (sig, addBytes) => {
      const res = await fetch(CF_DOWN(DOWN_CHUNK), { cache: 'no-store', signal: sig });
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        addBytes(value.length);
      }
    },
  });
}

function measureUpload(cfg, signal, onProgress) {
  const payload = new Uint8Array(UP_CHUNK);
  crypto.getRandomValues(payload.subarray(0, Math.min(65536, payload.length)));
  for (let offset = 65536; offset < payload.length; offset += 65536) {
    payload.set(payload.subarray(0, Math.min(65536, payload.length - offset)), offset);
  }

  return runAdaptiveTransfer({
    cfg,
    signal,
    onProgress,
    doRequest: (sig, addBytes) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let lastLoaded = 0;
        xhr.open('POST', CF_UP, true);
        xhr.upload.onprogress = (e) => {
          addBytes(e.loaded - lastLoaded);
          lastLoaded = e.loaded;
        };
        xhr.onloadend = () => resolve();
        xhr.onerror = () => reject(new Error('upload-failed'));
        const onAbort = () => xhr.abort();
        sig.addEventListener('abort', onAbort, { once: true });
        xhr.send(payload);
      }),
  });
}

async function loadClientInfo(signal) {
  try {
    const res = await fetch(IP_INFO, { signal });
    const data = await res.json();
    if (data && data.success !== false) {
      const isp = data.connection?.isp || data.connection?.org || '';
      const place = [data.city, data.country_code].filter(Boolean).join(', ');
      els.clientMeta.textContent = [place, data.ip, isp].filter(Boolean).join('   ');
    } else {
      els.clientMeta.textContent = 'unavailable';
    }
  } catch (_) {
    els.clientMeta.textContent = 'unavailable';
  }
  els.serverMeta.textContent = 'Cloudflare global network (nearest edge, auto-selected)';
}

// ---------------- orchestration ----------------

function resetUI() {
  displayedNumber = 0;
  els.mainNumber.textContent = '0';
  els.mainUnit.textContent = 'Mbps';
  els.phaseLabel.textContent = 'Getting ready…';
  els.latUnloaded.textContent = '–';
  els.latLoaded.textContent = '–';
  els.uploadSpeed.textContent = '–';
  els.downloadTotal.textContent = '–';
  els.uploadTotal.textContent = '–';
  els.details.classList.toggle('is-ready', !!settings.alwaysShow);
  setRing(0);
  [...els.steps.children].forEach((el) => el.classList.remove('is-active', 'is-done'));
}

function setControlIcon(mode) {
  els.iconPlay.style.display = mode === 'play' ? '' : 'none';
  els.iconPause.style.display = mode === 'pause' ? '' : 'none';
  els.iconRedo.style.display = mode === 'redo' ? '' : 'none';
  els.controlBtn.classList.toggle('is-running', mode === 'pause');
  els.controlBtn.setAttribute(
    'aria-label',
    mode === 'play' ? 'Start test' : mode === 'pause' ? 'Cancel test' : 'Run again'
  );
}

async function runTest() {
  if (autoStartTimer) {
    clearTimeout(autoStartTimer);
    autoStartTimer = null;
  }
  state = 'running';
  abortCtl = new AbortController();
  const { signal } = abortCtl;
  resetUI();
  setControlIcon('pause');

  const cfg = { connMin: settings.connMin, connMax: settings.connMax, durMin: settings.durMin, durMax: settings.durMax };

  loadClientInfo(signal);

  try {
    // 1. latency
    setStep('latency');
    els.phaseLabel.textContent = 'Testing latency';
    els.mainUnit.textContent = 'ms';
    setRing(0.03);
    const unloaded = await measureUnloadedLatency(signal);
    els.latUnloaded.textContent = unloaded.toFixed(0);
    animateNumberTo(unloaded);
    setRing(0.1);
    await sleep(200);

    // 2. download (with loaded-latency sampling running alongside)
    setStep('download');
    els.phaseLabel.textContent = 'Testing download speed';
    els.mainUnit.textContent = 'Mbps';
    els.details.classList.add('is-ready');

    let dlStopped = false;
    const loadedSamples = [];
    const dlPingLoop = pingLoop(signal, () => dlStopped, loadedSamples);

    const dl = await measureDownload(cfg, signal, (mbps, totalBytes) => {
      animateNumberTo(mbps, { duration: 150 });
      setRing(0.1 + Math.min(mbps / 300, 1) * 0.4);
      els.downloadTotal.textContent = formatMB(totalBytes);
    });
    dlStopped = true;
    await dlPingLoop;
    checkAbort(signal);
    animateNumberTo(dl.mbps, { duration: 200 });
    els.downloadTotal.textContent = formatMB(dl.totalBytes);
    setRing(0.5);
    await sleep(200);

    // 3. upload (optionally also sampling loaded latency)
    setStep('upload');
    els.phaseLabel.textContent = 'Testing upload speed';

    let ulStopped = false;
    let ulPingLoop = Promise.resolve();
    if (settings.loadedUpload) {
      ulPingLoop = pingLoop(signal, () => ulStopped, loadedSamples);
    }

    const ul = await measureUpload(cfg, signal, (mbps, totalBytes) => {
      els.uploadSpeed.textContent = mbps.toFixed(1);
      setRing(0.5 + Math.min(mbps / 150, 1) * 0.42);
      els.uploadTotal.textContent = formatMB(totalBytes);
    });
    ulStopped = true;
    await ulPingLoop;
    checkAbort(signal);
    els.uploadSpeed.textContent = ul.mbps.toFixed(1);
    els.uploadTotal.textContent = formatMB(ul.totalBytes);

    if (loadedSamples.length) {
      els.latLoaded.textContent = median(loadedSamples).toFixed(0);
    } else {
      els.latLoaded.textContent = unloaded.toFixed(0);
    }

    // done — headline number goes back to download, fast.com style
    els.mainUnit.textContent = 'Mbps';
    animateNumberTo(dl.mbps, { duration: 300 });
    els.phaseLabel.textContent = 'Your internet speed is';
    markAllStepsDone();
    setRing(1);
    state = 'done';
    setControlIcon('redo');
  } catch (err) {
    if (err.name === 'AbortError') {
      els.phaseLabel.textContent = 'Test cancelled';
      state = 'idle';
      setControlIcon('play');
      setRing(0);
    } else {
      console.error(err);
      els.phaseLabel.textContent = 'Could not reach the test server — check your connection';
      state = 'error';
      setControlIcon('redo');
    }
  }
}

function cancelTest() {
  if (abortCtl) abortCtl.abort();
  state = 'idle';
}

// ---------------- wiring: test control ----------------

els.controlBtn.addEventListener('click', () => {
  if (state === 'running') {
    cancelTest();
  } else {
    runTest();
  }
});

// ---------------- wiring: top nav ----------------

els.homeBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------------- wiring: About / FAQ modal ----------------

let lastFocused = null;

function openFaq() {
  lastFocused = document.activeElement;
  els.faqModal.removeAttribute('hidden');
  els.faqClose.focus();
  document.addEventListener('keydown', onFaqKeydown);
}

function closeFaq() {
  els.faqModal.setAttribute('hidden', '');
  document.removeEventListener('keydown', onFaqKeydown);
  if (lastFocused) lastFocused.focus();
}

function onFaqKeydown(e) {
  if (e.key === 'Escape') closeFaq();
}

els.aboutBtn.addEventListener('click', openFaq);
els.faqClose.addEventListener('click', closeFaq);
els.faqModal.addEventListener('click', (e) => {
  if (e.target === els.faqModal) closeFaq();
});

// ---------------- init ----------------

loadSettings();
resetUI();

function scheduleAutoStart() {
  autoStartTimer = setTimeout(() => {
    autoStartTimer = null;
    runTest();
  }, AUTOSTART_DELAY_MS);
}

if (document.readyState === 'complete') {
  scheduleAutoStart();
} else {
  window.addEventListener('load', scheduleAutoStart);
}
