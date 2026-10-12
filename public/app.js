const $ = (id) => document.getElementById(id);
const panel = $('broadcast');
const recordingMode = new URLSearchParams(location.search).get('record') === '1';
const automaticMode = !recordingMode && ['auto', 'aihot'].includes(new URLSearchParams(location.search).get('source'));
if (!recordingMode && new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embedded');
const frameMode = recordingMode && new URLSearchParams(location.search).get('frames') === '1';
if (recordingMode) {
  document.body.classList.add('recording');
  document.querySelector('h1').innerHTML = '今天，可以继续<br>创造了吗<span>？</span>';
}
let status = null;
let animationTimer;
let wipeTimer;
let pending = false;
let connected = false;
let automaticHelpers;
let automaticFeed;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

if (automaticMode) {
  $('result-title').textContent = '';
  $('result-description').textContent = '正在读取已确认公告…';
  $('result-kicker').textContent = 'CODEX / AUTO';
  $('phase-label').textContent = '读取公开公告';
  $('record-time').textContent = '按北京时间当天判定';
}

// Synthesize a layered stereo cue locally; no audio files or external requests.
let audioContext;
let masterGain;
let audioOutput;
let soundEnabled = true;
try { soundEnabled = localStorage.getItem('codex-signal-sound') !== 'off'; } catch {}
const activeSounds = new Set();

function updateSoundButton() {
  const ready = soundEnabled && audioContext?.state === 'running';
  $('sound-toggle').setAttribute('aria-pressed', String(!!ready));
  $('sound-label').textContent = ready ? '音效已开启' : soundEnabled ? '开启音效' : '音效已关闭';
  $('sound-toggle').title = ready ? '点击静音' : '点击启用音效，并重播揭晓动画';
}

async function enableAudio() {
  if (!soundEnabled) return;
  try {
    if (!audioContext) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) throw new Error('Audio unavailable');
      audioContext = new Audio();
      masterGain = audioContext.createGain();
      masterGain.gain.value = 1.4;
      audioOutput = audioContext.createDynamicsCompressor();
      audioOutput.threshold.value = -8;
      audioOutput.knee.value = 12;
      audioOutput.ratio.value = 8;
      audioOutput.attack.value = 0.003;
      audioOutput.release.value = 0.18;
      const clarity = audioContext.createBiquadFilter();
      clarity.type = 'highpass';
      clarity.frequency.value = 120;
      const brilliance = audioContext.createBiquadFilter();
      brilliance.type = 'highshelf';
      brilliance.frequency.value = 2200;
      brilliance.gain.value = 2.5;
      masterGain.connect(clarity);
      clarity.connect(brilliance);
      brilliance.connect(audioOutput);
      audioOutput.connect(audioContext.destination);
      audioContext.addEventListener('statechange', updateSoundButton);
    }
    await audioContext.resume();
  } catch {
    soundEnabled = false;
    $('sound-toggle').title = '当前浏览器无法启用音效';
  }
  updateSoundButton();
}

function stopSounds() {
  for (const source of activeSounds) source.stop();
  activeSounds.clear();
}

function tone(frequency, delay = 0, duration = 0.28, volume = 0.2, endFrequency = frequency, waveform = 'sine', pan = 0) {
  if (!soundEnabled || audioContext?.state !== 'running' || document.hidden) return;
  const at = audioContext.currentTime + delay;
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  const panner = audioContext.createStereoPanner();
  panner.pan.value = pan;
  oscillator.type = waveform;
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(volume, at + 0.003);
  envelope.gain.exponentialRampToValueAtTime(0.001, at + duration);
  oscillator.connect(envelope);
  envelope.connect(panner);
  panner.connect(masterGain);
  oscillator.onended = () => {
    activeSounds.delete(oscillator);
    oscillator.disconnect();
    envelope.disconnect();
    panner.disconnect();
  };
  activeSounds.add(oscillator);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

function swish(delay, duration = 0.3, direction = 1) {
  if (!soundEnabled || audioContext?.state !== 'running' || document.hidden) return;
  const at = audioContext.currentTime + delay;
  const buffer = audioContext.createBuffer(1, Math.ceil(audioContext.sampleRate * duration), audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const envelope = audioContext.createGain();
  const panner = audioContext.createStereoPanner();
  panner.pan.setValueAtTime(-0.75 * direction, at);
  panner.pan.linearRampToValueAtTime(0.75 * direction, at + duration);
  source.buffer = buffer;
  filter.type = 'bandpass';
  filter.Q.value = 0.7;
  filter.frequency.setValueAtTime(220, at);
  filter.frequency.exponentialRampToValueAtTime(3600, at + duration);
  envelope.gain.setValueAtTime(0, at);
  envelope.gain.linearRampToValueAtTime(0.2, at + duration * 0.4);
  envelope.gain.exponentialRampToValueAtTime(0.001, at + duration);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(panner);
  panner.connect(masterGain);
  source.onended = () => {
    activeSounds.delete(source);
    source.disconnect();
    filter.disconnect();
    envelope.disconnect();
    panner.disconnect();
  };
  activeSounds.add(source);
  source.start(at);
  source.stop(at + duration + 0.02);
}

function resultSound() {
  if (status.reset === null) return;
  // Bass, warm chord body, bell partials and alternating sparkles form one resolving cue.
  tone(status.reset ? 261.63 : 293.66, 0, 0.32, 0.19);
  const notes = status.reset ? [523.25, 659.25, 783.99, 1046.5] : [293.66, 349.23, 440];
  notes.forEach((note, i) => {
    const pan = (i % 2 ? 1 : -1) * 0.32;
    tone(note, i * 0.065, 0.6, 0.13, note, 'triangle', pan);
    tone(note * 2, i * 0.065, 0.55, 0.12, note * 2, 'sine', -pan);
    tone(note * 2.758, i * 0.065, 0.22, 0.055, note * 2.758, 'sine', pan);
  });
  const sparkles = status.reset ? [1568, 2093, 1318.51, 1568] : [880, 698.46];
  sparkles.forEach((note, i) => {
    const at = 0.48 + i * 0.15;
    const pan = i % 2 ? 0.6 : -0.6;
    tone(note, at, 0.32, 0.13, note, 'sine', pan);
    tone(note, at + 0.19, 0.48, 0.045, note, 'sine', -pan);
  });
}

function clock(now = new Date()) {
  if (automaticMode) {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    $('date-year').textContent = `${date.slice(0, 4)} / TODAY`;
    $('date').textContent = date.slice(5).replace('-', '.');
    $('weekday').textContent = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' });
    if (automaticFeed && status?.date !== date) applyAutomaticStatus(automaticFeed, now.getTime());
    return;
  }
  $('date-year').textContent = `${now.getFullYear()} / TODAY`;
  $('date').textContent = `${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  $('weekday').textContent = now.toLocaleDateString('zh-CN', { weekday: 'long' });

}

function displayResult() {
  if (automaticMode) {
    const confirmed = status.state === 'confirmed';
    const unavailable = status.state === 'unavailable';
    panel.dataset.state = confirmed ? 'yes' : 'unknown';
    $('result-kicker').textContent = confirmed ? 'A FRESH START' : 'CODEX / AUTO';
    $('result-title').textContent = confirmed ? '是，额度已重置' : unavailable ? '数据暂时无法加载' : '暂无已确认的重置公告';
    $('result-description').textContent = confirmed ? '' : unavailable ? '正在自动重试，请稍后再查看。' : '有新的已确认公告后会自动更新。';
    $('phase-label').textContent = unavailable ? '等待更新' : confirmed ? '自动播报' : '等待已确认公告';
    $('signal-code').textContent = confirmed ? 'RESET / YES' : unavailable ? 'UNAVAILABLE' : 'STANDBY';
    $('core-mark').setAttribute('d', confirmed ? 'M29 51 L44 66 L73 35' : 'M35 38 L23 50 L35 62 M65 38 L77 50 L65 62 M57 30 L43 70');
    const time = status.updatedAt || status.fetchedAt;
    const label = status.updatedAt ? '确认帖' : '数据更新';
    $('record-time').textContent = Number.isFinite(Date.parse(time)) ? `${label} · ${new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）` : '暂无可用公告数据';
    $('note-copy').innerHTML = confirmed ? '信号已亮起。<br>让那个想法，成为现实。' : unavailable ? '等待数据恢复。<br>结果确认后再开始。' : '等待公开公告。<br>下一次创造，从这里开始。';
    return;
  }
  const reset = status.reset;
  panel.dataset.state = reset === null ? 'unknown' : reset ? 'yes' : 'no';
  $('result-kicker').textContent = reset === null ? 'READY WHEN YOU ARE' : reset ? 'A FRESH START' : 'GOOD THINGS TAKE TIME';
  $('result-title').textContent = reset === null ? '等待首次播报' : reset ? '是，额度已重置' : '否，额度未重置';
  $('result-description').textContent = reset === null ? '在控制台发布状态，信号就会到达这里。' : reset ? '新的额度，新的可能。把想法变成下一件作品。' : '稍作停留，灵感不必停下。等下一次信号亮起。';
  $('phase-label').textContent = reset === null ? '等待播报' : '最新确认结果';
  $('signal-code').textContent = reset === null ? 'STANDBY' : reset ? 'RESET / YES' : 'RESET / NO';
  $('core-mark').setAttribute('d', reset === null ? 'M35 38 L23 50 L35 62 M65 38 L77 50 L65 62 M57 30 L43 70' : reset ? 'M29 51 L44 66 L73 35' : 'M39 32 L39 68 M61 32 L61 68');
  $('record-time').textContent = status.updatedAt ? `确认于 ${new Date(status.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '尚未发布状态';
  $('note-copy').innerHTML = reset === null ? '准备好你的灵感。<br>下一次创造，从这里开始。' : reset ? '信号已亮起。<br>让那个想法，成为现实。' : '等待，也是创造的一部分。<br>先让好想法，慢慢成形。';
}

function applyAutomaticStatus(feed, now = Date.now()) {
  const next = automaticHelpers.todayBroadcast(feed, now);
  const changed = !status || next.reset !== status.reset || next.date !== status.date || next.state !== status.state;
  status = next;
  if (changed) reveal();
  else if (!panel.classList.contains('revealing')) displayResult();
}

function reveal() {
  stopSounds();
  clearTimeout(animationTimer);
  clearTimeout(wipeTimer);
  panel.classList.remove('revealing', 'revealed', 'wiping');
  $('replay').disabled = true;
  if (reducedMotion.matches || status.reset === null) {
    displayResult();
    resultSound();
    $('replay').disabled = status.reset === null;
    return;
  }
  panel.dataset.state = 'unknown';
  $('phase-label').textContent = '正在揭晓';
  $('result-kicker').textContent = 'READING THE LATEST SIGNAL';
  $('result-title').textContent = '接收最新信号';
  $('result-description').textContent = '稍等片刻，答案即将揭晓。';
  $('signal-code').textContent = 'RECEIVING';
  $('core-mark').setAttribute('d', 'M35 38 L23 50 L35 62 M65 38 L77 50 L65 62 M57 30 L43 70');
  // Restart the timeline for consecutive publications and manual replay.
  void panel.offsetWidth;
  panel.classList.add('revealing');
  tone(880, 0, 0.09, 0.2, 1320);
  [523.25, 659.25, 783.99, 1046.5].forEach((note, i) => {
    tone(note, i * 0.16, 0.24, 0.17, note * 1.04, 'triangle', i % 2 ? 0.45 : -0.45);
  });
  [0.25, 0.57, 0.89, 1.21].forEach((at, i) => {
    tone(1650, at, 0.055, 0.11, 480, 'triangle', i % 2 ? -0.5 : 0.5);
  });
  swish(0.48, 0.32, 1);
  tone(1760, 0.52, 0.11, 0.1, 880);
  swish(1.04, 0.38, -1);
  tone(2093, 1.08, 0.13, 0.11, 1046.5);
  wipeTimer = setTimeout(() => {
    panel.classList.add('wiping');
    swish(0, 0.5);
    tone(180, 0, 0.48, 0.23, 900, 'triangle');
  }, 1550);
  animationTimer = setTimeout(() => {
    displayResult();
    panel.classList.remove('revealing', 'wiping');
    panel.classList.add('revealed');
    resultSound();
    $('replay').disabled = false;
  }, 2200);
}

async function sync() {
  if (pending) return;
  pending = true;
  try {
    const response = await fetch(automaticMode ? '/api/aihot-reset' : '/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('读取失败');
    const next = await response.json();
    if (automaticMode) {
      automaticHelpers ||= await import('./monitor-data.js?v=20261011-broadcast-states2');
      const nextStatus = automaticHelpers.todayBroadcast(next);
      automaticFeed = next;
      connected = nextStatus.state !== 'unavailable';
      $('connection-dot').classList.toggle('offline', !connected);
      $('connection-label').textContent = connected ? '自动更新' : '缓存数据 · 等待更新';
      applyAutomaticStatus(next);
      return;
    }
    connected = true;
    $('connection-dot').classList.remove('offline');
    $('connection-label').textContent = '本地信号已连接';
    if (!status || next.updatedAt !== status.updatedAt || next.reset !== status.reset) {
      status = next;
      if (recordingMode) {
        $('result-title').textContent = '今天，重置了吗？';
        $('result-description').textContent = '一个新信号，即将到达。';
        $('phase-label').textContent = '准备揭晓';
      } else reveal();
    }
  } catch {
    connected = false;
    $('connection-dot').classList.add('offline');
    $('connection-label').textContent = '连接中断，正在重试';
    if (automaticMode) {
      automaticFeed = null;
      status = { reset: null, state: 'unavailable' };
      reveal();
      return;
    }
    if (!status) {
      $('result-title').textContent = '信号暂时中断';
      $('result-description').textContent = '请确认本地服务正在运行，页面会自动重试。';
    }
  } finally { pending = false; }
}
$('replay').addEventListener('click', async () => {
  $('replay').disabled = true;
  await enableAudio();
  if (status) reveal();
});
$('sound-toggle').addEventListener('click', async () => {
  const ready = soundEnabled && audioContext?.state === 'running';
  soundEnabled = !ready;
  try { localStorage.setItem('codex-signal-sound', soundEnabled ? 'on' : 'off'); } catch {}
  if (!soundEnabled) {
    stopSounds();
    updateSoundButton();
    return;
  }
  $('sound-toggle').disabled = true;
  await enableAudio();
  $('sound-toggle').disabled = false;
  if (soundEnabled && status && status.reset !== null) reveal();
});
updateSoundButton();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSounds();
  else { clock(); sync(); }
});
clock();
sync();
if (!frameMode) setInterval(clock, 1000);
if (!recordingMode) setInterval(() => { if (!document.hidden || !connected) sync(); }, automaticMode ? 30_000 : 3000);

// The local recording script captures this exact Web Audio mix alongside the page video.
if (recordingMode) {
  window.recordSignal = async () => {
    if (!status || status.reset === null) throw new Error('请先确认并发布重置状态');
    soundEnabled = true;
    await enableAudio();
    if (audioContext?.state !== 'running') throw new Error('录制音效无法启动');
    const destination = audioContext.createMediaStreamDestination();
    audioOutput.connect(destination);
    const recorder = new MediaRecorder(destination.stream);
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    await new Promise(resolve => setTimeout(resolve, 500));
    const startedAt = Date.now();
    recorder.start();
    document.body.classList.add('recording-ready');
    await new Promise(resolve => setTimeout(resolve, 800));
    reveal();
    await new Promise(resolve => setTimeout(resolve, 7200));
    recorder.stop();
    await stopped;
    audioOutput.disconnect(destination);
    destination.stream.getTracks().forEach(track => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { audio: btoa(binary), startedAt, reset: status.reset };
  };
}

// Sample the same CSS choreography at exact 1/120-second intervals for a sharp export.
if (frameMode) {
  let frameStage;
  let frameStart;
  let animationOrigins;
  window.beginFrameRender = startedAt => {
    frameStart = startedAt;
    frameStage = 'intro';
    animationOrigins = new WeakMap();
    soundEnabled = false;
    stopSounds();
    clearTimeout(animationTimer);
    clearTimeout(wipeTimer);
    panel.classList.remove('revealing', 'revealed', 'wiping');
    panel.dataset.state = 'unknown';
    $('result-kicker').textContent = 'READY WHEN YOU ARE';
    $('result-title').textContent = '今天，重置了吗？';
    $('result-description').textContent = '一个新信号，即将到达。';
    $('phase-label').textContent = '准备揭晓';
    $('signal-code').textContent = 'STANDBY';
    $('core-mark').setAttribute('d', 'M35 38 L23 50 L35 62 M65 38 L77 50 L65 62 M57 30 L43 70');
    $('note-copy').innerHTML = '准备好你的灵感。<br>下一次创造，从这里开始。';
    $('record-time').textContent = '尚未揭晓';
  };
  window.renderSignalFrame = milliseconds => {
    let origin = 0;
    if (frameStage === 'intro' && milliseconds >= 800) {
      reveal();
      clearTimeout(animationTimer);
      clearTimeout(wipeTimer);
      frameStage = 'reveal';
      origin = 800;
    }
    if (frameStage === 'reveal' && milliseconds >= 2350) {
      panel.classList.add('wiping');
      frameStage = 'wipe';
      origin = 2350;
    }
    if (frameStage === 'wipe' && milliseconds >= 3000) {
      displayResult();
      panel.classList.remove('revealing', 'wiping');
      panel.classList.add('revealed');
      frameStage = 'result';
      origin = 3000;
    }
    clock(new Date(frameStart + milliseconds));
    for (const animation of document.getAnimations()) {
      if (!animationOrigins.has(animation)) {
        animation.pause();
        animationOrigins.set(animation, origin);
      }
      animation.currentTime = milliseconds - animationOrigins.get(animation);
    }
    return { stage: frameStage, title: $('result-title').textContent };
  };
}
