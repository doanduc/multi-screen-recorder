/**
 * Multi Screen Recorder - frontend
 * Screen capture via getDisplayMedia, composition via canvas, MediaRecorder,
 * save/convert through Tauri commands.
 */

(function () {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  const MAX_SCREENS = 4;
  // Frame rate the composite canvas is driven at, and what the recorder targets.
  const DEFAULT_FPS = 30;

  // --- Elements ---
  const screenGrid = document.getElementById('screen-grid');
  const screenEmpty = document.getElementById('screen-empty');
  const sourceHint = document.getElementById('source-hint');
  const sourceError = document.getElementById('source-error');
  const btnAddScreen = document.getElementById('btn-add-screen');
  const toggleMic = document.getElementById('toggle-mic');
  const toggleSystemAudio = document.getElementById('toggle-system-audio');
  const toggleWebcam = document.getElementById('toggle-webcam');
  const toggleStopTimer = document.getElementById('toggle-stop-timer');
  const timerMinutes = document.getElementById('timer-minutes');
  const timerSeconds = document.getElementById('timer-seconds');
  const timerCountdownEl = document.getElementById('timer-countdown');
  const selectResolution = document.getElementById('select-resolution');
  const selectFormat = document.getElementById('select-format');
  const rangeBitrate = document.getElementById('range-bitrate');
  const qualityName = document.getElementById('quality-name');
  const qualityHint = document.getElementById('quality-hint');
  const qualityBars = document.querySelectorAll('#quality-preview .qp-bar');
  const estimateSize = document.getElementById('estimate-size');
  const webcamOptions = document.getElementById('webcam-options');
  const webcamPositionPicker = document.getElementById('webcam-position');
  const toggleWebcamCircle = document.getElementById('toggle-webcam-circle');
  const webcamPreview = document.getElementById('webcam-preview');
  const webcamPreviewVideo = document.getElementById('webcam-preview-video');
  const btnTheme = document.getElementById('btn-theme');
  const statusEl = document.getElementById('status');
  const statusDot = document.getElementById('status-dot');
  const durationEl = document.getElementById('duration');
  const recIndicator = document.getElementById('rec-indicator');
  const btnRecord = document.getElementById('btn-record');
  const recordLabel = btnRecord.querySelector('.record-label');
  const btnPreview = document.getElementById('btn-preview');
  const btnConvertFile = document.getElementById('btn-convert-file');
  const previewModal = document.getElementById('preview-modal');
  const previewVideo = document.getElementById('preview-video');
  const previewTitle = document.getElementById('preview-title');
  const btnClosePreview = document.getElementById('btn-close-preview');
  const recordingsPathEl = document.getElementById('recordings-path');
  const btnChangeRecordings = document.getElementById('btn-change-recordings');
  const btnOpenRecordings = document.getElementById('btn-open-recordings');
  const convertProgressEl = document.getElementById('convert-progress');
  const convertProgressLabel = document.getElementById('convert-progress-label');
  const convertProgressFill = document.getElementById('convert-progress-fill');
  const convertProgressPct = document.getElementById('convert-progress-pct');

  // --- State ---
  let screens = []; // { id, stream, label, tile }
  let screenSeq = 0;
  let selectedCodec = 'vp8';
  let selectedBitrate = 3000000;
  let maxRes = { w: 1920, h: 1080 };
  let targetFps = DEFAULT_FPS;
  let convertToMp4 = false;
  let webcamPosition = 'bottom-right';
  let webcamCircle = false;

  // Quality presets the slider maps onto. Bitrate drives both file size and how
  // well fine detail (small text especially) survives compression.
  const QUALITY_LEVELS = [
    { rate: 1000000, name: 'Draft', hint: 'Smallest file — fine for rough captures, text may blur' },
    { rate: 2000000, name: 'Light', hint: 'Small file — readable text on simple screens' },
    { rate: 3000000, name: 'Balanced', hint: 'Text stays readable — good for most recordings' },
    { rate: 5000000, name: 'Sharp', hint: 'Crisp text and smooth motion — larger file' },
    { rate: 8000000, name: 'Maximum', hint: 'Best clarity for small text and video — largest file' }
  ];
  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStream = null;
  let webcamStream = null;
  let micStream = null;
  let audioContext = null;
  let compositeCleanups = [];
  let durationInterval = null;
  let startTime = null;
  let stopTimeoutId = null;
  let countdownIntervalId = null;
  let lastSavedPath = null;

  // --- Titlebar ---
  document.getElementById('tl-close').addEventListener('click', () => appWindow.close());
  document.getElementById('tl-min').addEventListener('click', () => appWindow.minimize());
  document.getElementById('tl-max').addEventListener('click', () => appWindow.toggleMaximize());

  // --- Helpers ---
  function showError(msg) {
    sourceError.textContent = msg || '';
    sourceError.classList.toggle('hidden', !msg);
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
  }

  function baseName(p) {
    return p.split(/[/\\]/).pop();
  }

  function updateHint() {
    if (screens.length === 0) {
      sourceHint.textContent = 'Arrange screens to define the video layout';
    } else {
      const layout = screens.length === 2 ? '2×1' : screens.length > 2 ? '2×2' : '1×1';
      sourceHint.textContent = screens.length + ' screen' + (screens.length > 1 ? 's' : '') +
        ' — combined as a ' + layout + ' grid in a single video';
    }
    btnAddScreen.disabled = screens.length >= MAX_SCREENS || isRecording;
    screenEmpty.classList.toggle('hidden', screens.length > 0);
    screenGrid.classList.toggle('locked', isRecording);
  }

  function showConvertProgress(fileName) {
    convertProgressEl.classList.remove('hidden');
    convertProgressLabel.textContent = 'Converting ' + (fileName || '…');
    convertProgressFill.style.width = '0%';
    convertProgressPct.textContent = '0%';
  }

  function updateConvertProgress(percent, fileName) {
    convertProgressFill.style.width = percent + '%';
    convertProgressPct.textContent = percent + '%';
    if (fileName) convertProgressLabel.textContent = 'Converting ' + fileName;
  }

  function hideConvertProgress() {
    convertProgressEl.classList.add('hidden');
  }

  // --- Screen management ---
  async function addScreen() {
    showError('');
    if (screens.length >= MAX_SCREENS) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: targetFps } },
        // Ask for system audio on the first screen; user can tick "share audio" in the picker
        audio: screens.length === 0
      });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return; // user canceled
      showError('Could not capture screen: ' + (e.message || e.name || 'unknown error'));
      return;
    }

    const id = ++screenSeq;
    const track = stream.getVideoTracks()[0];
    let label = (track && track.label) || '';
    if (!label || /^(screen|window|web-contents-media-stream):/i.test(label)) {
      const surface = track && track.getSettings ? track.getSettings().displaySurface : null;
      label = (surface === 'window' ? 'Window' : 'Screen') + ' ' + id;
    }

    const tile = document.createElement('div');
    tile.className = 'screen-tile';
    tile.dataset.id = String(id);
    const handle = document.createElement('span');
    handle.className = 'tile-handle';
    handle.title = 'Drag to reorder';
    handle.innerHTML =
      '<svg viewBox="0 0 16 10" fill="currentColor">' +
      '<circle cx="3" cy="3" r="1.3"/><circle cx="8" cy="3" r="1.3"/><circle cx="13" cy="3" r="1.3"/>' +
      '<circle cx="3" cy="7" r="1.3"/><circle cx="8" cy="7" r="1.3"/><circle cx="13" cy="7" r="1.3"/>' +
      '</svg>';
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.srcObject = stream;
    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    const labelEl = document.createElement('span');
    labelEl.className = 'tile-label';
    labelEl.textContent = label;
    labelEl.title = label;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'tile-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove this screen';
    removeBtn.addEventListener('click', () => removeScreen(id));
    tile.append(video, handle, badge, labelEl, removeBtn);
    attachTileDrag(tile);
    screenGrid.appendChild(tile);

    const entry = { id, stream, label, tile };
    screens.push(entry);

    // If user stops sharing from the OS/browser UI
    if (track) {
      track.addEventListener('ended', () => {
        if (isRecording) stopRecording();
        removeScreen(id);
      });
    }

    renumberBadges();
    updateHint();
  }

  function removeScreen(id) {
    const idx = screens.findIndex((s) => s.id === id);
    if (idx < 0) return;
    if (isRecording) return; // don't remove mid-recording (except via track ended -> stop first)
    const [entry] = screens.splice(idx, 1);
    entry.stream.getTracks().forEach((t) => t.stop());
    entry.tile.remove();
    renumberBadges();
    updateHint();
  }

  function renumberBadges() {
    screens.forEach((s, i) => {
      s.tile.querySelector('.tile-badge').textContent = String(i + 1);
    });
  }

  // --- Reordering ---
  // Order decides where each source lands in the grid, so dragging tiles is how
  // the layout gets arranged. Locked while recording: the canvas reads this
  // array every frame and reshuffling mid-take would swap cells in the video.
  //
  // Uses pointer events rather than HTML5 drag-and-drop: the app sets
  // `user-select: none` globally, which stops WebView2 from ever firing
  // dragstart, and pointer capture also gives smoother feedback.
  function attachTileDrag(tile) {
    let dragging = false;
    let startX = 0;
    let startY = 0;

    function tileUnder(x, y) {
      return document
        .elementsFromPoint(x, y)
        .find((el) => el.classList && el.classList.contains('screen-tile'));
    }

    function clearTargets() {
      screenGrid.querySelectorAll('.drop-target').forEach((el) => {
        el.classList.remove('drop-target');
      });
    }

    tile.addEventListener('pointerdown', (e) => {
      // Left button only, and never from the remove button.
      if (e.button !== 0 || isRecording) return;
      if (e.target.closest('.tile-remove')) return;

      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      tile.setPointerCapture(e.pointerId);
    });

    tile.addEventListener('pointermove', (e) => {
      if (!tile.hasPointerCapture(e.pointerId) || isRecording) return;

      // Only start once the pointer clears a small threshold, so a plain click
      // on the tile does not count as a drag.
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        dragging = true;
        tile.classList.add('dragging');
      }

      clearTargets();
      const over = tileUnder(e.clientX, e.clientY);
      if (over && over !== tile) over.classList.add('drop-target');
    });

    function finish(e) {
      if (!tile.hasPointerCapture(e.pointerId)) return;
      tile.releasePointerCapture(e.pointerId);
      if (!dragging) return;

      dragging = false;
      tile.classList.remove('dragging');
      clearTargets();

      const over = tileUnder(e.clientX, e.clientY);
      if (!over || over === tile) return;

      const from = screens.findIndex((s) => s.tile === tile);
      const to = screens.findIndex((s) => s.tile === over);
      if (from < 0 || to < 0) return;

      const [moved] = screens.splice(from, 1);
      screens.splice(to, 0, moved);

      // Re-append in the new order so the DOM matches the array.
      screens.forEach((s) => screenGrid.appendChild(s.tile));
      renumberBadges();
    }

    tile.addEventListener('pointerup', finish);
    tile.addEventListener('pointercancel', finish);
  }

  // --- Audio merge ---
  function mergeAudioStreams(systemStream, mic) {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    if (systemStream && systemStream.getAudioTracks().length > 0) {
      audioContext.createMediaStreamSource(systemStream).connect(destination);
    }
    if (mic && mic.getAudioTracks().length > 0) {
      audioContext.createMediaStreamSource(mic).connect(destination);
    }
    return destination.stream;
  }

  // --- Canvas composition ---
  // Lays screens out in a grid (1 -> 1x1, 2 -> 2x1, 3-4 -> 2x2), each cell letterboxed,
  // then scales the whole canvas down (never up) to fit within maxW x maxH.
  // Uses rAF plus an interval fallback so drawing continues when the window is occluded.
  function startComposite(screenStreams, webcamTrack, maxW, maxH) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const videos = screenStreams.map((s) => {
      const v = document.createElement('video');
      v.autoplay = true;
      v.muted = true;
      v.srcObject = s;
      v.play().catch(() => {});
      return v;
    });

    let webcamVideo = null;
    if (webcamTrack) {
      webcamVideo = document.createElement('video');
      webcamVideo.autoplay = true;
      webcamVideo.muted = true;
      webcamVideo.srcObject = new MediaStream([webcamTrack]);
      webcamVideo.play().catch(() => {});
    }

    const n = videos.length;
    const cols = n <= 1 ? 1 : 2;
    const rows = Math.ceil(n / cols);

    function draw() {
      if (!videos.every((v) => v.videoWidth > 0)) return;
      // Uniform cells sized by the largest source, capped to the selected resolution
      const cellW = Math.max(...videos.map((v) => v.videoWidth));
      const cellH = Math.max(...videos.map((v) => v.videoHeight));
      const naturalW = cols * cellW;
      const naturalH = rows * cellH;
      const scale = Math.min(1, maxW / naturalW, maxH / naturalH);
      const outW = Math.max(2, Math.round((naturalW * scale) / 2) * 2);
      const outH = Math.max(2, Math.round((naturalH * scale) / 2) * 2);
      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);
      const cw = outW / cols;
      const ch = outH / rows;
      videos.forEach((v, i) => {
        const cx = (i % cols) * cw;
        const cy = Math.floor(i / cols) * ch;
        const s = Math.min(cw / v.videoWidth, ch / v.videoHeight);
        const dw = v.videoWidth * s;
        const dh = v.videoHeight * s;
        ctx.drawImage(v, cx + (cw - dw) / 2, cy + (ch - dh) / 2, dw, dh);
      });
      if (webcamVideo && webcamVideo.videoWidth) {
        const pad = Math.max(8, Math.round(outW * 0.01));
        const vw = webcamVideo.videoWidth;
        const vh = webcamVideo.videoHeight;

        // A circle needs a square frame; a rectangle keeps the camera's aspect.
        const w = Math.floor(outW * 0.2);
        const h = webcamCircle ? w : Math.floor(w * (vh / vw));

        const right = webcamPosition.endsWith('right');
        const bottom = webcamPosition.startsWith('bottom');
        const x = right ? outW - w - pad : pad;
        const y = bottom ? outH - h - pad : pad;

        ctx.save();
        if (webcamCircle) {
          ctx.beginPath();
          ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
          ctx.clip();
        }
        // Cover the frame: crop the long edge instead of squashing the picture.
        const scale = Math.max(w / vw, h / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.drawImage(webcamVideo, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
        ctx.restore();
      }
    }

    // captureStream(fps) only sets an upper bound: Chromium emits a frame only
    // when the canvas pixels actually change. Recording a still desktop then
    // yields ~1 fps -- one frame each time the taskbar clock ticks -- which
    // looks frozen when scrubbing. Drive the stream manually instead so every
    // recording runs at a real, constant frame rate.
    const stream = canvas.captureStream(0);
    const [canvasTrack] = stream.getVideoTracks();
    const frameMs = 1000 / targetFps;

    let animId = null;
    let lastFrame = 0;

    function pushFrame(now) {
      draw();
      if (canvasTrack && typeof canvasTrack.requestFrame === 'function') {
        canvasTrack.requestFrame();
      }
      lastFrame = now;
    }

    function loop(now) {
      if (now - lastFrame >= frameMs - 1) pushFrame(now);
      animId = requestAnimationFrame(loop);
    }
    animId = requestAnimationFrame(loop);

    // rAF stops when the window is occluded, and a main-thread setInterval gets
    // clamped to ~1 Hz in the background. A worker's timer keeps its rate, so
    // use one as the metronome that keeps frames flowing while hidden.
    const tickSrc =
      'let id=null;onmessage=(e)=>{' +
      'if(e.data.stop){clearInterval(id);return;}' +
      'clearInterval(id);id=setInterval(()=>postMessage(0),e.data.ms);};';
    const tickUrl = URL.createObjectURL(new Blob([tickSrc], { type: 'text/javascript' }));
    const ticker = new Worker(tickUrl);
    ticker.onmessage = () => {
      const now = performance.now();
      if (now - lastFrame >= frameMs - 1) pushFrame(now);
    };
    ticker.postMessage({ ms: frameMs });

    compositeCleanups.push(() => {
      if (animId !== null) cancelAnimationFrame(animId);
      ticker.postMessage({ stop: true });
      ticker.terminate();
      URL.revokeObjectURL(tickUrl);
      videos.forEach((v) => { v.srcObject = null; });
      if (webcamVideo) webcamVideo.srcObject = null;
    });

    return stream;
  }

  function stopComposite() {
    compositeCleanups.forEach((cb) => cb());
    compositeCleanups = [];
  }

  // --- Recording ---
  async function startRecording() {
    showError('');
    if (screens.length === 0) {
      showError('Please add at least one screen first.');
      return;
    }

    const useMic = toggleMic.checked;
    const useSystemAudio = toggleSystemAudio.checked;
    const useWebcam = toggleWebcam.checked;

    micStream = null;
    webcamStream = null;

    if (useMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        showError('Microphone not available: ' + (e.message || 'permission denied'));
        return;
      }
    }

    // The preview usually opened the camera already; only ask again if it did not.
    if (useWebcam && !webcamStream) {
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
      } catch (e) {
        showError('Webcam not available: ' + (e.message || 'permission denied'));
        if (micStream) micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        return;
      }
    }

    // Video track: single screen within the resolution cap and no webcam records
    // directly; otherwise composite through the canvas (grid + scaling)
    let videoTrack;
    let canvasStream = null;
    const track0 = screens[0].stream.getVideoTracks()[0];
    const settings0 = track0 && track0.getSettings ? track0.getSettings() : {};
    const exceedsCap =
      (settings0.width || 0) > maxRes.w || (settings0.height || 0) > maxRes.h;
    const needComposite = screens.length > 1 || (useWebcam && webcamStream) || exceedsCap;
    if (needComposite) {
      canvasStream = startComposite(
        screens.map((s) => s.stream),
        useWebcam && webcamStream ? webcamStream.getVideoTracks()[0] : null,
        maxRes.w,
        maxRes.h
      );
      videoTrack = canvasStream.getVideoTracks()[0];
    } else {
      videoTrack = track0;
    }

    // Audio: system audio comes from the first screen's display stream (if shared)
    const tracks = [videoTrack];
    if (useMic || useSystemAudio) {
      const merged = mergeAudioStreams(useSystemAudio ? screens[0].stream : null, useMic ? micStream : null);
      if (merged.getAudioTracks().length > 0) tracks.push(merged.getAudioTracks()[0]);
    }
    recordStream = new MediaStream(tracks);

    const videoBitrate = selectedBitrate;
    let mimeType = 'video/webm';
    if (selectedCodec === 'vp9' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
      mimeType = 'video/webm;codecs=vp9';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      mimeType = 'video/webm;codecs=vp8';
    }
    let recorderMime = mimeType;
    try {
      mediaRecorder = new MediaRecorder(recordStream, {
        mimeType,
        videoBitsPerSecond: videoBitrate,
        audioBitsPerSecond: 128000
      });
    } catch (e) {
      mediaRecorder = new MediaRecorder(recordStream);
      recorderMime = 'video/webm';
    }

    recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      clearAutoStop();
      stopDurationTimer();
      setStatus('Processing…', 'busy');

      const blob = new Blob(recordedChunks, { type: recorderMime });
      recordedChunks = [];
      const doConvert = convertToMp4;
      cleanupAfterRecording();

      try {
        const buffer = await blob.arrayBuffer();
        let savedPath = await invoke('save_webm', new Uint8Array(buffer));
        if (doConvert) {
          setStatus('Converting to MP4…', 'busy');
          showConvertProgress(baseName(savedPath));
          savedPath = await invoke('convert_to_mp4', { webmPath: savedPath });
        }
        hideConvertProgress();
        lastSavedPath = savedPath;
        btnPreview.disabled = false;
        setStatus('Saved: ' + baseName(savedPath));
      } catch (err) {
        hideConvertProgress();
        setStatus('Error', 'error');
        showError(String(err && err.message ? err.message : err));
      }
    };

    // timeslice 1000 ms: flush every 1s = regular keyframes, stable duration
    mediaRecorder.start(1000);
    isRecording = true;
    startTime = Date.now();
    startDurationTimer();
    setStatus('Recording…', 'recording');
    recIndicator.classList.remove('hidden');
    btnRecord.classList.add('recording');
    btnRecord.title = 'Stop recording';
    recordLabel.textContent = 'Stop recording';
    btnAddScreen.disabled = true;
    btnConvertFile.disabled = true;
    updateHint();

    // Auto-stop timer
    if (toggleStopTimer.checked) {
      const min = Math.max(0, parseInt(timerMinutes.value, 10) || 0);
      const sec = Math.max(0, Math.min(59, parseInt(timerSeconds.value, 10) || 0));
      const totalMs = (min * 60 + sec) * 1000;
      if (totalMs > 0) {
        stopTimeoutId = setTimeout(() => stopRecording(), totalMs);
        timerCountdownEl.classList.remove('hidden');
        let remaining = min * 60 + sec;
        const tick = () => {
          if (remaining < 0) return;
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          timerCountdownEl.textContent = 'Stops in ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
          remaining--;
        };
        tick();
        countdownIntervalId = setInterval(tick, 1000);
      }
    }
  }

  function clearAutoStop() {
    if (stopTimeoutId) { clearTimeout(stopTimeoutId); stopTimeoutId = null; }
    if (countdownIntervalId) { clearInterval(countdownIntervalId); countdownIntervalId = null; }
    timerCountdownEl.classList.add('hidden');
  }

  function cleanupAfterRecording() {
    // Screens keep streaming for the next take; only stop recording-specific resources
    stopComposite();
    if (recordStream) {
      // Only stop tracks we created (canvas/merged audio), not the live screen tracks
      recordStream.getTracks().forEach((t) => {
        const isScreenTrack = screens.some((s) => s.stream.getTracks().includes(t));
        if (!isScreenTrack) t.stop();
      });
      recordStream = null;
    }
    // Keep the camera running if the toggle is still on, so its preview stays live.
    if (webcamStream && !toggleWebcam.checked) {
      webcamStream.getTracks().forEach((t) => t.stop());
      webcamStream = null;
    } else if (webcamStream) {
      webcamPreviewVideo.srcObject = webcamStream;
      webcamPreviewVideo.play().catch(() => {});
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    mediaRecorder = null;
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    clearAutoStop();
    mediaRecorder.stop();
    isRecording = false;
    recIndicator.classList.add('hidden');
    btnRecord.classList.remove('recording');
    btnRecord.title = 'Start recording';
    recordLabel.textContent = 'Start recording';
    btnConvertFile.disabled = false;
    updateHint();
  }

  function startDurationTimer() {
    durationInterval = setInterval(() => {
      if (!startTime) return;
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      durationEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }, 500);
  }

  function stopDurationTimer() {
    if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }
    durationEl.textContent = '00:00';
    startTime = null;
  }

  // --- Preview ---
  // Serve the file over the stream:// protocol, which answers range requests so
  // seeking jumps straight to the target instead of reading from the start.
  function streamUrl(path) {
    return 'http://stream.localhost/' + encodeURIComponent(path);
  }

  function showPreview() {
    if (!lastSavedPath) return;
    previewVideo.src = streamUrl(lastSavedPath);
    previewTitle.textContent = baseName(lastSavedPath);
    previewModal.classList.remove('hidden');
  }

  function closePreview() {
    previewVideo.pause();
    previewVideo.src = '';
    previewModal.classList.add('hidden');
  }

  // --- Convert existing file ---
  async function convertFile() {
    showError('');
    setStatus('Choose a file…', 'busy');
    try {
      const result = await invoke('convert_file_to_mp4');
      hideConvertProgress();
      if (result.canceled) { setStatus('Ready'); return; }
      if (result.error) {
        setStatus('Error', 'error');
        showError(result.error);
        return;
      }
      lastSavedPath = result.path;
      btnPreview.disabled = false;
      setStatus('Converted: ' + baseName(result.path));
    } catch (err) {
      hideConvertProgress();
      setStatus('Error', 'error');
      showError(String(err));
    }
  }

  // --- Events from backend ---
  listen('convert-progress', (event) => {
    const { fileName, percent } = event.payload;
    if (convertProgressEl.classList.contains('hidden')) showConvertProgress(fileName);
    updateConvertProgress(percent, fileName);
  });

  // --- UI wiring ---
  btnAddScreen.addEventListener('click', addScreen);
  btnRecord.addEventListener('click', () => {
    if (isRecording) stopRecording();
    else startRecording();
  });
  btnPreview.addEventListener('click', showPreview);
  btnConvertFile.addEventListener('click', convertFile);
  btnClosePreview.addEventListener('click', closePreview);
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) closePreview();
  });

  // VP8/VP9 in MediaRecorder encode variable-bitrate: videoBitsPerSecond is a
  // ceiling, not a target, and a mostly-static screen lands far below it.
  // Measured against real recordings at the 3 Mbps setting, a still desktop used
  // about 5-7% of the ceiling and a busy one about 40-50%, so quote that span
  // instead of the ceiling itself, which overstated size by roughly 15x.
  const STILL_RATIO = 0.06;
  const ACTIVE_RATIO = 0.45;

  function mbFor(bps, seconds, ratio) {
    return (bps * ratio / 8) * seconds / (1024 * 1024);
  }

  function formatSize(mb) {
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB';
  }

  function formatEstimate() {
    // Audio is close to constant bitrate, so it is counted in full.
    const audioBps = toggleMic.checked || toggleSystemAudio.checked ? 128000 : 0;
    const audioMb = (audioBps / 8) * 600 / (1024 * 1024);
    const low = mbFor(selectedBitrate, 600, STILL_RATIO) + audioMb;
    const high = mbFor(selectedBitrate, 600, ACTIVE_RATIO) + audioMb;
    return formatSize(low) + '–' + formatSize(high);
  }

  function updateQuality() {
    const level = QUALITY_LEVELS[parseInt(rangeBitrate.value, 10)] || QUALITY_LEVELS[2];
    selectedBitrate = level.rate;
    qualityName.textContent = level.name;
    qualityHint.textContent = level.hint;
    qualityBars.forEach((bar, i) => {
      bar.classList.toggle('on', i <= parseInt(rangeBitrate.value, 10));
    });
    estimateSize.textContent = formatEstimate();
  }

  rangeBitrate.addEventListener('input', updateQuality);
  toggleMic.addEventListener('change', updateQuality);
  toggleSystemAudio.addEventListener('change', updateQuality);

  selectResolution.addEventListener('change', () => {
    const [w, h] = selectResolution.value.split('x').map(Number);
    maxRes = { w: w || 1920, h: h || 1080 };
  });

  // "mp4" records WebM first, then converts; the codec picks the WebM encoder.
  selectFormat.addEventListener('change', () => {
    const v = selectFormat.value;
    convertToMp4 = v === 'mp4';
    selectedCodec = v === 'webm-vp9' ? 'vp9' : 'vp8';
  });

  // --- Webcam options ---
  // Open the camera as soon as it is switched on, so the corner and shape
  // choices can be judged against a live picture instead of guessed at.
  async function startWebcamPreview() {
    if (webcamStream) return;
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (e) {
      showError('Could not open the camera: ' + (e.message || e.name || 'unknown error'));
      toggleWebcam.checked = false;
      webcamOptions.classList.add('hidden');
      return;
    }
    webcamPreviewVideo.srcObject = webcamStream;
    webcamPreviewVideo.play().catch(() => {});
    webcamPreview.classList.remove('hidden');
  }

  function stopWebcamPreview() {
    webcamPreview.classList.add('hidden');
    webcamPreviewVideo.srcObject = null;
    // Keep the stream alive while recording - the composite canvas is using it.
    if (webcamStream && !isRecording) {
      webcamStream.getTracks().forEach((t) => t.stop());
      webcamStream = null;
    }
  }

  function updateWebcamPreview() {
    webcamPreview.classList.toggle('circle', webcamCircle);
    webcamPreview.dataset.pos = webcamPosition;
  }

  toggleWebcam.addEventListener('change', () => {
    const on = toggleWebcam.checked;
    webcamOptions.classList.toggle('hidden', !on);
    if (on) startWebcamPreview();
    else stopWebcamPreview();
  });

  webcamPositionPicker.querySelectorAll('.corner').forEach((btn) => {
    btn.addEventListener('click', () => {
      webcamPosition = btn.dataset.pos;
      webcamPositionPicker.querySelectorAll('.corner').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });
      updateWebcamPreview();
    });
  });

  toggleWebcamCircle.addEventListener('change', () => {
    webcamCircle = toggleWebcamCircle.checked;
    updateWebcamPreview();
  });

  function updateTimerInputs() {
    const disabled = !toggleStopTimer.checked;
    timerMinutes.disabled = disabled;
    timerSeconds.disabled = disabled;
  }
  toggleStopTimer.addEventListener('change', updateTimerInputs);
  updateTimerInputs();

  btnChangeRecordings.addEventListener('click', async () => {
    try {
      const result = await invoke('change_recordings_path');
      if (result && !result.canceled && result.path) {
        recordingsPathEl.textContent = result.path;
        recordingsPathEl.title = result.path;
      }
    } catch (e) {
      showError(String(e));
    }
  });

  btnOpenRecordings.addEventListener('click', () => {
    invoke('open_recordings_folder').catch((e) => showError(String(e)));
  });

  // --- About ---
  const aboutModal = document.getElementById('about-modal');
  const btnAbout = document.getElementById('btn-about');
  const btnCloseAbout = document.getElementById('btn-close-about');

  function openEmail() {
    invoke('open_feedback_email').catch((e) => showError(String(e)));
  }

  btnAbout.addEventListener('click', () => aboutModal.classList.remove('hidden'));
  btnCloseAbout.addEventListener('click', () => aboutModal.classList.add('hidden'));
  aboutModal.addEventListener('click', (e) => {
    if (e.target === aboutModal) aboutModal.classList.add('hidden');
  });
  document.getElementById('btn-email').addEventListener('click', openEmail);
  document.getElementById('link-email').addEventListener('click', (e) => {
    e.preventDefault();
    openEmail();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    aboutModal.classList.add('hidden');
    if (!previewModal.classList.contains('hidden')) closePreview();
  });

  // --- Theme ---
  // Remembered per machine; falls back to whatever the OS reports.
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btnTheme.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {
      /* private mode or blocked storage - the theme still applies for this run */
    }
  }

  function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem('theme');
    } catch (e) {
      /* ignore */
    }
    if (saved !== 'dark' && saved !== 'light') {
      saved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    applyTheme(saved);
  }

  btnTheme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });

  // --- Init ---
  initTheme();
  updateQuality();
  const [initW, initH] = selectResolution.value.split('x').map(Number);
  maxRes = { w: initW || 1920, h: initH || 1080 };

  invoke('get_recordings_path')
    .then((p) => {
      recordingsPathEl.textContent = p || '—';
      recordingsPathEl.title = p || '';
    })
    .catch(() => {});
  updateHint();
  setStatus('Ready');
})();
