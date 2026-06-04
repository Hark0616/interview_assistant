// panel.js — Lógica de la ventana pop-out (modo sigiloso)
// Recibe estado del content script vía chrome.runtime messaging.
// Envía comandos de vuelta vía background relay → content script.
// Usa: window.__ia.utils (escapeHtml, FONT_LEVELS, renderCaptionLines)

(function () {
  'use strict';

  const { escapeHtml, FONT_LEVELS, renderCaptionLines } = window.__ia.utils;

  // ── Refs a elementos DOM ──

  const el = {
    statusDot:        document.getElementById('ia-panel-status-dot'),
    statusText:       document.getElementById('ia-panel-status-text'),
    transcript:       document.getElementById('ia-panel-transcript'),
    transcriptSection: document.getElementById('ia-panel-transcript-section'),
    suggestion:       document.getElementById('ia-panel-suggestion'),
    loading:          document.getElementById('ia-panel-loading'),
    activateBtn:      document.getElementById('ia-panel-activate-btn'),
    copyBtn:          document.getElementById('ia-panel-copy-btn'),
    refreshBtn:       document.getElementById('ia-panel-refresh-btn'),
    sendBtn:          document.getElementById('ia-panel-send-btn'),
    modeAuto:         document.getElementById('ia-panel-mode-auto'),
    modeManual:       document.getElementById('ia-panel-mode-manual'),
    debounceRow:      document.getElementById('ia-panel-debounce-row'),
    debounceSlider:   document.getElementById('ia-panel-debounce-slider'),
    debounceVal:      document.getElementById('ia-panel-debounce-val'),
    userNote:         document.getElementById('ia-panel-user-note'),
    collapseBtn:      document.getElementById('ia-panel-collapse-btn'),
    followBtn:        document.getElementById('ia-panel-follow-btn'),
    fontBtn:          document.getElementById('ia-panel-font-btn'),
    dockBtn:          document.getElementById('ia-panel-dock-btn'),
    downloadLog:      document.getElementById('ia-panel-download-log'),
    disconnected:     document.getElementById('ia-panel-disconnected'),
  };

  // ── Estado local del panel ──

  let connected = false;
  let followLatest = true;
  let transcriptCollapsed = false;
  let currentSuggestionText = '';
  let fontIdx = 0;
  let noteErrorTimer = null;

  // ── Comunicación con content script (vía background relay) ──

  function showNoteRelayError(message) {
    if (!el.userNote || !el.statusText) return;
    el.userNote.classList.add('ia-note-relay-error');
    el.statusText.textContent = message;
    clearTimeout(noteErrorTimer);
    noteErrorTimer = setTimeout(() => {
      el.userNote.classList.remove('ia-note-relay-error');
    }, 2000);
  }

  function clearNoteRelayError() {
    if (!el.userNote) return;
    el.userNote.classList.remove('ia-note-relay-error');
  }

  function sendCommand(command, data, opts = {}) {
    const { silent = false } = opts;
    return chrome.runtime.sendMessage({ type: 'IA_PANEL_COMMAND', command, data })
      .then(() => {
        if (command === 'setNote') clearNoteRelayError();
      })
      .catch((err) => {
        if (!silent && command === 'setNote') {
          const detail = err?.message ? ` (${err.message})` : '';
          showNoteRelayError(`No se pudo sincronizar la nota${detail}`);
        }
      });
  }

  // ── Actualización de UI desde estado recibido ──

  function updateUI(state) {
    markConnected();
    updateStatusDot(state.statusState);
    updateStatusText(state.statusText);
    if (state.transcript) updateTranscript(state.transcript, state.myName);
    if (state.suggestion != null) updateSuggestion(state.suggestion);
    if (state.isLoading != null) updateLoading(state.isLoading);
    if (state.isActive != null) updateActivateBtn(state.isActive);
    if (state.manualMode != null) updateModeButtons(state.manualMode);
    if (state.debounceMs != null) updateDebounce(state.debounceMs);
    if (state.userNote != null && document.activeElement !== el.userNote) {
      el.userNote.value = state.userNote;
    }
  }

  function markConnected() {
    if (!connected) {
      connected = true;
      el.disconnected.style.display = 'none';
    }
  }

  function updateStatusDot(statusState) {
    if (!el.statusDot || !statusState) return;
    el.statusDot.className = 'ia-status-dot';
    el.statusDot.classList.add(`ia-dot-${statusState}`);
  }

  function updateStatusText(text) {
    if (el.statusText && text != null) el.statusText.textContent = text;
  }

  function updateTranscript(lines, myName) {
    if (!el.transcript) return;
    el.transcript.innerHTML = renderCaptionLines(lines, myName);
    if (followLatest) el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function updateSuggestion(suggestion) {
    if (suggestion.isError) {
      el.suggestion.innerHTML = `<span class="ia-error">${escapeHtml(suggestion.text)}</span>`;
    } else if (suggestion.text) {
      el.suggestion.innerHTML = `<span class="ia-suggestion-text">${escapeHtml(suggestion.text)}</span>`;
      currentSuggestionText = suggestion.text;
    }
  }

  function updateLoading(isLoading) {
    el.loading.style.display = isLoading ? 'flex' : 'none';
    el.suggestion.style.opacity = isLoading ? '0.3' : '1';
  }

  function updateActivateBtn(isActive) {
    el.activateBtn.textContent = isActive ? 'Detener' : 'Activar';
    el.activateBtn.classList.toggle('active', isActive);
  }

  function updateModeButtons(manual) {
    el.modeManual.classList.toggle('active', manual);
    el.modeAuto.classList.toggle('active', !manual);
    el.sendBtn.style.display = manual ? 'flex' : 'none';
    el.debounceRow.style.display = manual ? 'none' : 'flex';
  }

  function updateDebounce(ms) {
    el.debounceSlider.value = ms;
    el.debounceVal.textContent = (ms / 1000).toFixed(1) + 's';
  }

  // ── Event handlers ──

  function setupEvents() {
    el.activateBtn.addEventListener('click', () => sendCommand('toggleActivate'));

    el.copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(currentSuggestionText).catch(() => {});
      el.copyBtn.textContent = 'OK';
      setTimeout(() => { el.copyBtn.textContent = 'Copiar'; }, 1500);
    });

    el.refreshBtn.addEventListener('click', () => sendCommand('requestSuggestion'));
    el.sendBtn.addEventListener('click', () => sendCommand('requestSuggestion'));
    el.downloadLog.addEventListener('click', () => sendCommand('downloadLog'));

    el.modeAuto.addEventListener('click', () => sendCommand('setMode', { manual: false }));
    el.modeManual.addEventListener('click', () => sendCommand('setMode', { manual: true }));

    el.debounceSlider.addEventListener('input', () => {
      const ms = parseInt(el.debounceSlider.value);
      el.debounceVal.textContent = (ms / 1000).toFixed(1) + 's';
      sendCommand('setDebounce', { ms });
    });

    el.userNote.addEventListener('input', () => {
      sendCommand('setNote', { text: el.userNote.value });
    });

    el.collapseBtn.addEventListener('click', () => {
      transcriptCollapsed = !transcriptCollapsed;
      el.transcriptSection.classList.toggle('ia-collapsed', transcriptCollapsed);
      el.collapseBtn.textContent = transcriptCollapsed ? '▸' : '▾';
      el.collapseBtn.title = transcriptCollapsed ? 'Mostrar transcripción' : 'Ocultar transcripción';
    });

    el.followBtn.addEventListener('click', () => {
      followLatest = !followLatest;
      el.followBtn.classList.toggle('active', followLatest);
      el.followBtn.textContent = followLatest ? '↓ Auto' : 'Fijo';
      if (followLatest) el.transcript.scrollTop = el.transcript.scrollHeight;
    });

    el.fontBtn.addEventListener('click', () => {
      fontIdx = (fontIdx + 1) % FONT_LEVELS.length;
      const lvl = FONT_LEVELS[fontIdx];
      document.documentElement.style.setProperty('--ia-fs-suggestion', lvl.suggestion);
      document.documentElement.style.setProperty('--ia-fs-text', lvl.text);
      el.fontBtn.textContent = lvl.label;
    });

    el.dockBtn.addEventListener('click', () => {
      sendCommand('dockBack');
      setTimeout(() => window.close(), 200);
    });
  }

  // ── Messaging (recepción de estado) ──

  let missedPings = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'IA_PANEL_STATE') {
      missedPings = 0;
      updateUI(msg.data);
    }
  });

  setInterval(() => {
    if (!connected) return;
    missedPings++;
    if (missedPings > 6) el.disconnected.style.display = 'flex';
  }, 5000);

  // ── Init ──

  setupEvents();
  chrome.runtime.sendMessage({ type: 'IA_PANEL_READY' }).catch(() => {
    showNoteRelayError('Panel sin conexión con la reunión');
  });
})();
