/*
  Tempo — a small, dependency-free internet speed test.
  Measures latency, download and upload throughput against
  Cloudflare's public, CORS-enabled speed test endpoints.
*/

const CF_DOWN = (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`;
const CF_UP = 'https://speed.cloudflare.com/__up';
const IP_INFO = 'https://ipwho.is/';

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
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  dlSize: document.getElementById('dlSize'),
  ulSize: document.getElementById('ulSize'),
  autoStart: document.getElementById('autoStart'),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 96;
els.ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

let state = 'idle'; // idle | running | done | error
let abortCtl = null;
let displayedNumber = 0;
let animFrame = null;

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

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bytesToMbps(bytes, seconds) {
  if (seconds <= 0) return 0;
  return (bytes * 8) / seconds / 1_000_000;
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

async function measureDownload(totalBytesTarget, signal, onProgress) {
  const streamCount = 4;
  const perStreamBytes = Math.ceil(totalBytesTarget / streamCount);
  let totalLoaded = 0;
  const testStart = performance.now();
  let lastTick = testStart;
  let lastLoaded = 0;
  let peak = 0;

  function report(force) {
    const now = performance.now();
    if (!force && now - lastTick < 150) return;
    const windowSeconds = (now - lastTick) / 1000;
    const windowBytes = totalLoaded - lastLoaded;
    const instMbps = bytesToMbps(windowBytes, windowSeconds);
    if (instMbps > 0) peak = Math.max(peak, instMbps);
    const overallMbps = bytesToMbps(totalLoaded, (now - testStart) / 1000);
    onProgress(overallMbps || instMbps);
    lastTick = now;
    lastLoaded = totalLoaded;
  }

  async function runStream() {
    const res = await fetch(CF_DOWN(perStreamBytes), { cache: 'no-store', signal });
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLoaded += value.length;
      report(false);
    }
  }

  await Promise.all(Array.from({ length: streamCount }, runStream));
  report(true);
  const elapsed = (performance.now() - testStart) / 1000;
  return { mbps: bytesToMbps(totalLoaded, elapsed), peak };
}

async function measureUpload(totalBytesTarget, signal, onProgress) {
  const streamCount = 3;
  const perStreamBytes = Math.ceil(totalBytesTarget / streamCount);
  const payload = new Uint8Array(perStreamBytes);
  crypto.getRandomValues(payload.subarray(0, Math.min(65536, payload.length)));
  // repeat the random seed across the buffer (fast + good enough entropy for a transfer test)
  for (let offset = 65536; offset < payload.length; offset += 65536) {
    payload.set(payload.subarray(0, Math.min(65536, payload.length - offset)), offset);
  }

  let totalLoaded = 0;
  const testStart = performance.now();
  let lastTick = testStart;

  function report(force) {
    const now = performance.now();
    if (!force && now - lastTick < 150) return;
    const overallMbps = bytesToMbps(totalLoaded, (now - testStart) / 1000);
    onProgress(overallMbps);
    lastTick = now;
  }

  function runStream() {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', CF_UP, true);
      xhr.upload.onprogress = (e) => {
        totalLoaded += e.loaded - (xhr._lastLoaded || 0);
        xhr._lastLoaded = e.loaded;
        report(false);
      };
      xhr.onloadend = () => resolve();
      xhr.onerror = () => reject(new Error('upload-failed'));
      signal.addEventListener('abort', () => xhr.abort());
      xhr.send(payload);
    });
  }

  await Promise.all(Array.from({ length: streamCount }, runStream));
  report(true);
  const elapsed = (performance.now() - testStart) / 1000;
  return bytesToMbps(totalLoaded, elapsed);
}

async function loadClientInfo(signal) {
  try {
    const res = await fetch(IP_INFO, { signal });
    const data = await res.json();
    if (data && data.success !== false) {
      const parts = [data.city, data.region, data.country_code].filter(Boolean);
      const isp = data.connection?.isp || data.connection?.org;
      els.clientMeta.textContent = `Client\u00A0\u00A0${[data.ip, isp].filter(Boolean).join(' \u00B7 ')}${parts.length ? ' \u00B7 ' + parts.join(', ') : ''}`;
    }
  } catch (_) {
    els.clientMeta.textContent = 'Client\u00A0\u00A0unavailable';
  }
}

// ---------------- orchestration ----------------

function resetUI() {
  displayedNumber = 0;
  els.mainNumber.textContent = '0';
  els.mainUnit.textContent = 'Mbps';
  els.phaseLabel.textContent = 'Press start to begin';
  els.latUnloaded.textContent = '–';
  els.latLoaded.textContent = '–';
  els.uploadSpeed.textContent = '–';
  els.details.classList.remove('is-ready');
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
  state = 'running';
  abortCtl = new AbortController();
  const { signal } = abortCtl;
  resetUI();
  setControlIcon('pause');

  const dlTarget = Number(els.dlSize.value);
  const ulTarget = Number(els.ulSize.value);

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
    setRing(0.12);
    await sleep(250);

    // 2. download
    setStep('download');
    els.phaseLabel.textContent = 'Testing download speed';
    els.mainUnit.textContent = 'Mbps';
    els.details.classList.add('is-ready');

    let loadedLatencySamples = [];
    const pingDuringDownload = (async () => {
      while (state === 'running') {
        try {
          loadedLatencySamples.push(await pingOnce(signal));
        } catch (_) { /* stream may be saturated; ignore */ }
        await sleep(400);
      }
    })();

    const dl = await measureDownload(dlTarget, signal, (mbps) => {
      animateNumberTo(mbps, { duration: 150 });
      setRing(0.12 + Math.min(mbps / 300, 1) * 0.4);
    });
    animateNumberTo(dl.mbps, { duration: 200 });
    await sleep(150);
    state = 'download-done';
    await pingDuringDownload;
    if (loadedLatencySamples.length) {
      els.latLoaded.textContent = median(loadedLatencySamples).toFixed(0);
    } else {
      els.latLoaded.textContent = unloaded.toFixed(0);
    }
    state = 'running';
    setRing(0.55);
    await sleep(200);

    // 3. upload
    setStep('upload');
    els.phaseLabel.textContent = 'Testing upload speed';
    const ul = await measureUpload(ulTarget, signal, (mbps) => {
      els.uploadSpeed.textContent = mbps.toFixed(1);
      setRing(0.55 + Math.min(mbps / 150, 1) * 0.42);
    });
    els.uploadSpeed.textContent = ul.toFixed(1);

    // done — show download as the headline number, fast.com style
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cancelTest() {
  if (abortCtl) abortCtl.abort();
  state = 'idle';
}

// ---------------- wiring ----------------

els.controlBtn.addEventListener('click', () => {
  if (state === 'running') {
    cancelTest();
  } else {
    runTest();
  }
});

els.settingsBtn.addEventListener('click', () => {
  const isHidden = els.settingsPanel.hasAttribute('hidden');
  if (isHidden) {
    els.settingsPanel.removeAttribute('hidden');
    els.settingsBtn.setAttribute('aria-expanded', 'true');
  } else {
    els.settingsPanel.setAttribute('hidden', '');
    els.settingsBtn.setAttribute('aria-expanded', 'false');
  }
});

document.getElementById('unitsToggle').addEventListener('click', () => {
  // Placeholder for a future Mbps/MBps toggle; kept simple & honest for v1.
  els.mainUnit.textContent = els.mainUnit.textContent === 'Mbps' ? 'Mbps' : 'Mbps';
});

resetUI();

if (localStorage.getItem('tempo-autostart') === '1') {
  els.autoStart.checked = true;
}
els.autoStart.addEventListener('change', () => {
  localStorage.setItem('tempo-autostart', els.autoStart.checked ? '1' : '0');
});
if (els.autoStart.checked) {
  window.addEventListener('load', () => runTest());
}
