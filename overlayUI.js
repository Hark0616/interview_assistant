// overlayUI.js — UI del overlay flotante (creación, eventos, renderizado)
// Factory: window.__ia.createOverlayUI(state, C, modules)
// Dependencias cruzadas (late binding): modules.sessionLog, modules.ai, modules.captionCapture
// Usa: window.__ia.utils (escapeHtml, FONT_LEVELS, renderCaptionLines)

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.createOverlayUI = function (state, C, modules) {
    const { escapeHtml, FONT_LEVELS, renderCaptionLines } = window.__ia.utils;

    let transcriptScrollProgrammatic = false;
    let panelUpdateTimer = null;
    let lastSuggestionForPanel = { text: '', isError: false };

    // ── Helpers internos ──

    function setTranscriptScrollProgrammaticForNextFrame() {
      transcriptScrollProgrammatic = true;
      requestAnimationFrame(() => { transcriptScrollProgrammatic = false; });
    }

    // ── Panel pop-out: reenvío de estado ──

    function sendPanelUpdate(partial) {
      if (!state.panelActive) return;
      if (panelUpdateTimer) clearTimeout(panelUpdateTimer);
      panelUpdateTimer = setTimeout(() => {
        panelUpdateTimer = null;
        const data = {
          isActive: state.isActive,
          isLoading: state.isLoading,
          manualMode: state.manualModeActive,
          debounceMs: state.config?.debounceMs || 1800,
          userNote: state.userNote || '',
          statusText: document.getElementById('ia-status-text')?.textContent || '',
          statusState: document.getElementById('ia-status-dot')?.className?.match(/ia-dot-(\w+)/)?.[1] || 'idle',
          transcript: state.captionBuffer.slice(-5).map(c => ({ role: c.role, speaker: c.speaker, text: c.text })),
          suggestion: lastSuggestionForPanel,
          myName: state.config?.myName || '',
          hasConfig: !!state.config?.apiKey,
          ...partial,
        };
        chrome.runtime.sendMessage({ type: 'IA_PANEL_STATE', data }).catch(() => {});
      }, 80);
    }

    // ── API pública: renderizado ──

    function updateTranscriptFollowBtn() {
      const btn = document.getElementById('ia-transcript-follow-btn');
      if (!btn) return;
      if (state.transcriptFollowLatest) {
        btn.textContent = '↓ Auto';
        btn.classList.add('active');
        btn.title = 'Auto-scroll activo: baja al último mensaje. Clic para fijar posición.';
      } else {
        btn.textContent = 'Fijo';
        btn.classList.remove('active');
        btn.title = 'Scroll fijo: no salta al final. Clic para reactivar auto-scroll.';
      }
    }

    function updateStatus(text, statusState) {
      const statusText = document.getElementById('ia-status-text');
      const statusDot = document.getElementById('ia-status-dot');
      if (statusText) statusText.textContent = text;
      if (statusDot) {
        statusDot.className = 'ia-status-dot';
        statusDot.classList.add(`ia-dot-${statusState || 'idle'}`);
      }
      sendPanelUpdate();
    }

    function renderTranscript() {
      const transcriptEl = document.getElementById('ia-transcript');
      if (!transcriptEl) return;

      let fromBottom = 0;
      if (!state.transcriptFollowLatest && transcriptEl.clientHeight > 0) {
        fromBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
      }

      transcriptEl.innerHTML = renderCaptionLines(
        state.captionBuffer.slice(-5),
        state.config?.myName
      );

      setTranscriptScrollProgrammaticForNextFrame();
      if (state.transcriptFollowLatest) {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      } else {
        const max = Math.max(0, transcriptEl.scrollHeight - transcriptEl.clientHeight);
        const target = transcriptEl.scrollHeight - transcriptEl.clientHeight - fromBottom;
        transcriptEl.scrollTop = Math.max(0, Math.min(max, target));
      }
      sendPanelUpdate();
    }

    function displaySuggestion(text, isError) {
      const el = document.getElementById('ia-suggestion');
      if (!el) return;
      el.innerHTML = isError
        ? `<span class="ia-error">${escapeHtml(text)}</span>`
        : `<span class="ia-suggestion-text">${escapeHtml(text)}</span>`;
      lastSuggestionForPanel = { text, isError: !!isError };
      sendPanelUpdate();
    }

    function setLoadingState(loading) {
      const loadingEl = document.getElementById('ia-loading');
      const suggestionEl = document.getElementById('ia-suggestion');
      if (!loadingEl || !suggestionEl) return;
      loadingEl.style.display = loading ? 'flex' : 'none';
      suggestionEl.style.opacity = loading ? '0.3' : '1';
      sendPanelUpdate();
    }

    function highlightManualBtn() {
      const btn = document.getElementById('ia-send-btn');
      if (btn) btn.classList.add('ia-send-pulse');
    }

    // ── API pública: acciones (llamadas por handlePanelCommand) ──

    function toggleActivate() {
      if (!state.config?.apiKey) {
        updateStatus('Configura el API key primero', 'error');
        return;
      }
      state.isActive = !state.isActive;
      if (state.isActive) {
        const btn = document.getElementById('ia-activate-btn');
        if (btn) { btn.textContent = 'Preparando...'; btn.disabled = true; }
        (async () => {
          modules.sessionLog.resetSessionLog();
          if (!state.condensedProfile) await modules.ai.generateCondensedProfile();
          modules.captionCapture.startCaptionObserver();
          if (btn) { btn.textContent = 'Detener'; btn.disabled = false; btn.classList.add('active'); }
        })();
      } else {
        modules.captionCapture.stopCaptionObserver();
        clearTimeout(state.debounceTimer);
        const btn = document.getElementById('ia-activate-btn');
        if (btn) { btn.textContent = 'Activar'; btn.classList.remove('active'); }
        updateStatus('Detenido', 'idle');
      }
    }

    function setMode(manual) {
      state.manualModeActive = manual;
      const btnAuto = document.getElementById('ia-mode-auto');
      const btnManual = document.getElementById('ia-mode-manual');
      const sendBtn = document.getElementById('ia-send-btn');
      const debounceRow = document.getElementById('ia-debounce-row');
      if (manual) {
        btnManual?.classList.add('active');
        btnAuto?.classList.remove('active');
        if (sendBtn) sendBtn.style.display = 'flex';
        if (debounceRow) debounceRow.style.display = 'none';
        clearTimeout(state.debounceTimer);
      } else {
        btnAuto?.classList.add('active');
        btnManual?.classList.remove('active');
        if (sendBtn) sendBtn.style.display = 'none';
        if (debounceRow) debounceRow.style.display = 'flex';
      }
      if (state.config) state.config.manualMode = manual;
    }

    function setDebounce(ms) {
      const slider = document.getElementById('ia-debounce-slider');
      const valLabel = document.getElementById('ia-debounce-val');
      if (slider) slider.value = ms;
      if (valLabel) valLabel.textContent = (ms / 1000).toFixed(1) + 's';
      if (state.config) state.config.debounceMs = ms;
      chrome.storage.local.get(['iaConfig'], (r) => {
        const updated = { ...(r.iaConfig || {}), debounceMs: ms };
        chrome.storage.local.set({ iaConfig: updated });
      });
    }

    function setUserNote(text) {
      state.userNote = text;
      const noteEl = document.getElementById('ia-user-note');
      if (noteEl) noteEl.value = text;
    }

    function showOverlay() {
      if (state.overlay) state.overlay.style.display = 'flex';
    }

    function hideOverlay() {
      if (state.overlay) state.overlay.style.display = 'none';
    }

    /** Oculta/muestra el overlay (modo sigiloso). No aplica si el panel pop-out está activo. */
    function toggleStealthVisibility() {
      if (!state.overlay || state.panelActive) return;
      const hidden = state.overlay.style.display === 'none';
      state.overlay.style.display = hidden ? 'flex' : 'none';
    }

    // ── Drag ──

    function makeDraggable(el) {
      const header = el.querySelector('#ia-header');
      let isDragging = false;
      let startX, startY, startLeft, startTop;

      header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        header.style.cursor = 'grabbing';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        el.style.left = `${startLeft + e.clientX - startX}px`;
        el.style.top = `${startTop + e.clientY - startY}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        header.style.cursor = 'grab';
      });
    }

    // ── Event setup (descompuesto por zona) ──

    function setupTranscriptEvents() {
      const transcriptScrollEl = document.getElementById('ia-transcript');
      if (transcriptScrollEl) {
        transcriptScrollEl.addEventListener('scroll', () => {
          if (transcriptScrollProgrammatic) return;
          if (transcriptScrollEl.clientHeight <= 0) return;
          const fromBottom =
            transcriptScrollEl.scrollHeight - transcriptScrollEl.scrollTop - transcriptScrollEl.clientHeight;
          const nearBottom = fromBottom <= 32;
          if (nearBottom && !state.transcriptFollowLatest) {
            state.transcriptFollowLatest = true;
            updateTranscriptFollowBtn();
          } else if (!nearBottom && state.transcriptFollowLatest) {
            state.transcriptFollowLatest = false;
            updateTranscriptFollowBtn();
          }
        });
      }

      document.getElementById('ia-transcript-follow-btn').onclick = () => {
        state.transcriptFollowLatest = !state.transcriptFollowLatest;
        updateTranscriptFollowBtn();
        if (state.transcriptFollowLatest && transcriptScrollEl) {
          setTranscriptScrollProgrammaticForNextFrame();
          transcriptScrollEl.scrollTop = transcriptScrollEl.scrollHeight;
        }
      };

      const transcriptSection = document.getElementById('ia-transcript-section');
      const collapseBtn = document.getElementById('ia-transcript-collapse-btn');

      function applyTranscriptCollapse(collapsed) {
        state.transcriptCollapsed = collapsed;
        if (transcriptSection) transcriptSection.classList.toggle('ia-transcript-collapsed', collapsed);
        if (collapseBtn) {
          collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          collapseBtn.textContent = collapsed ? '▸' : '▾';
          collapseBtn.title = collapsed ? 'Mostrar transcripción' : 'Ocultar transcripción';
        }
      }

      if (state.transcriptCollapsed) applyTranscriptCollapse(true);
      if (collapseBtn) collapseBtn.onclick = () => applyTranscriptCollapse(!state.transcriptCollapsed);
    }

    function setupSuggestionEvents() {
      document.getElementById('ia-copy-btn').onclick = () => {
        const suggestion = document.getElementById('ia-suggestion').textContent;
        navigator.clipboard.writeText(suggestion).catch(() => {});
        document.getElementById('ia-copy-btn').textContent = 'OK';
        setTimeout(() => { document.getElementById('ia-copy-btn').textContent = 'Copiar'; }, 1500);
      };

      document.getElementById('ia-refresh-btn').onclick = () => {
        state.lastSentText = '';
        modules.ai.requestSuggestion();
      };

      document.getElementById('ia-send-btn').onclick = () => {
        state.lastSentText = '';
        modules.ai.requestSuggestion();
        document.getElementById('ia-send-btn').classList.remove('ia-send-pulse');
      };
    }

    function setupControlEvents() {
      const btnAuto = document.getElementById('ia-mode-auto');
      const btnManual = document.getElementById('ia-mode-manual');

      btnAuto.onclick = () => setMode(false);
      btnManual.onclick = () => setMode(true);

      const slider = document.getElementById('ia-debounce-slider');
      const valLabel = document.getElementById('ia-debounce-val');

      if (state.config?.debounceMs) {
        slider.value = state.config.debounceMs;
        valLabel.textContent = (state.config.debounceMs / 1000).toFixed(1) + 's';
      }

      slider.oninput = () => setDebounce(parseInt(slider.value));

      if (state.config?.manualMode) btnManual.click();
    }

    function setupNoteEvents() {
      const userNoteEl = document.getElementById('ia-user-note');
      if (userNoteEl) {
        userNoteEl.value = state.userNote || '';
        userNoteEl.addEventListener('input', (e) => { state.userNote = e.target.value; });
      }
    }

    function setupHeaderEvents() {
      document.getElementById('ia-close-btn').onclick = () => hideOverlay();

      let fontIdx = 0;
      document.getElementById('ia-font-btn').onclick = () => {
        fontIdx = (fontIdx + 1) % FONT_LEVELS.length;
        const lvl = FONT_LEVELS[fontIdx];
        state.overlay.style.setProperty('--ia-fs-suggestion', lvl.suggestion);
        state.overlay.style.setProperty('--ia-fs-text', lvl.text);
        document.getElementById('ia-font-btn').textContent = lvl.label;
      };

      let minimized = false;
      document.getElementById('ia-toggle-btn').onclick = () => {
        minimized = !minimized;
        document.getElementById('ia-body').style.display = minimized ? 'none' : 'flex';
        document.getElementById('ia-controls').style.display = minimized ? 'none' : 'flex';
        const noteSec = document.getElementById('ia-note-section');
        if (noteSec) noteSec.style.display = minimized ? 'none' : 'block';
        document.getElementById('ia-footer').style.display = minimized ? 'none' : 'flex';
        document.getElementById('ia-toggle-btn').textContent = minimized ? '+' : '-';
      };
    }

    function setupFooterEvents() {
      document.getElementById('ia-download-log').onclick = () => {
        if (state.sessionTranscript.length === 0 && state.sessionAiEvents.length === 0) {
          updateStatus('No hay registro aún (activa primero)', 'idle');
          return;
        }
        modules.sessionLog.downloadSessionLogFile();
        updateStatus('Registro exportado (.txt)', 'active');
      };

      document.getElementById('ia-activate-btn').onclick = () => toggleActivate();
    }

    function setupStealthEvents() {
      document.getElementById('ia-popout-btn').onclick = () => {
        chrome.runtime.sendMessage({ type: 'IA_OPEN_PANEL' }, (resp) => {
          if (resp?.success) {
            state.panelActive = true;
            hideOverlay();
            sendPanelUpdate();
          }
        });
      };

      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'h') {
          e.preventDefault();
          e.stopPropagation();
          toggleStealthVisibility();
        }
      });
    }

    function setupOverlayEvents() {
      setupTranscriptEvents();
      setupSuggestionEvents();
      setupControlEvents();
      setupNoteEvents();
      setupHeaderEvents();
      setupFooterEvents();
      setupStealthEvents();
    }

    // ── Creación del overlay ──

    function createOverlay() {
      if (document.getElementById('ia-interview-overlay')) return;

      state.overlay = document.createElement('div');
      state.overlay.id = 'ia-interview-overlay';
      state.overlay.innerHTML = `
        <div id="ia-header">
          <span id="ia-title">Reunión</span>
          <div id="ia-header-buttons">
            <span id="ia-status-dot" class="ia-status-dot" title="Estado"></span>
            <button id="ia-font-btn" title="Tamaño de letra">A</button>
            <button id="ia-popout-btn" title="Ventana separada (no se ve al compartir solo la pestaña de Meet). Atajo ocultar overlay: Ctrl+Shift+H o el que configures en Extensiones → Atajos de teclado">↗</button>
            <button id="ia-toggle-btn" title="Minimizar">-</button>
            <button id="ia-close-btn" title="Cerrar">X</button>
          </div>
        </div>

        <div id="ia-body">
          <div id="ia-transcript-section">
            <div class="ia-section-label ia-transcript-label-row">
              <span>Transcripción</span>
              <div class="ia-transcript-label-actions">
                <button type="button" id="ia-transcript-collapse-btn" class="ia-transcript-collapse-btn"
                  title="Ocultar transcripción" aria-expanded="true" aria-controls="ia-transcript-panel">▾</button>
                <button type="button" id="ia-transcript-follow-btn" class="ia-transcript-follow-btn active"
                  title="Auto-scroll activo: baja al último mensaje. Clic para fijar posición.">↓ Auto</button>
              </div>
            </div>
            <div id="ia-transcript-panel" role="region" aria-label="Transcripción reciente">
              <div id="ia-transcript"></div>
            </div>
          </div>

          <div id="ia-divider"></div>

          <div id="ia-suggestion-section">
            <div class="ia-section-label ia-section-label--primary">
              Sugerencia
              <div id="ia-suggestion-actions">
                <button type="button" id="ia-send-btn" title="Enviar contexto actual a la IA ahora" style="display:none">
                  Enviar
                </button>
                <button id="ia-copy-btn" title="Copiar sugerencia al portapapeles">Copiar</button>
                <button id="ia-refresh-btn" title="Pedir nueva sugerencia a la IA">↻ Regenerar</button>
              </div>
            </div>
            <div id="ia-suggestion">
              <span class="ia-placeholder">Aquí aparecerá la sugerencia cuando haya contexto de la conversación.</span>
            </div>
            <div id="ia-loading" style="display:none;">
              <div class="ia-spinner"></div>
              <span>Generando respuesta...</span>
            </div>
          </div>
        </div>

        <div id="ia-controls">
          <div id="ia-mode-row">
            <span class="ia-control-label">Modo:</span>
            <div id="ia-mode-toggle">
              <button id="ia-mode-auto" class="ia-mode-btn active" title="Dispara automáticamente tras silencio">Auto</button>
              <button id="ia-mode-manual" class="ia-mode-btn" title="Tú decides cuándo pedir sugerencia">Manual</button>
            </div>
          </div>
          <div id="ia-debounce-row">
            <span class="ia-control-label">Espera: <span id="ia-debounce-val">1.8s</span></span>
            <input type="range" id="ia-debounce-slider" min="500" max="5000" step="100" value="1800">
          </div>
        </div>

        <div id="ia-note-section">
          <label class="ia-note-label" for="ia-user-note">Nota para la IA</label>
          <textarea id="ia-user-note" rows="2" maxlength="1200"
            placeholder="Instrucciones puntuales para esta parte de la entrevista (tono, tema a priorizar, etc.). Se aplica hasta que borres el texto."
            spellcheck="true"></textarea>
        </div>

        <div id="ia-footer">
          <span id="ia-status-text">Listo. Activa para comenzar.</span>
          <div id="ia-footer-actions">
            <button type="button" id="ia-download-log" title="Exportar registro (.txt): transcripción + marcas de la IA">Exportar</button>
            <button id="ia-activate-btn">Activar</button>
          </div>
        </div>
      `;

      document.body.appendChild(state.overlay);
      setupOverlayEvents();
      makeDraggable(state.overlay);
    }

    // ── Interfaz pública del módulo ──

    return {
      createOverlay,
      renderTranscript,
      displaySuggestion,
      setLoadingState,
      updateStatus,
      highlightManualBtn,
      sendPanelUpdate,
      // APIs para comandos del panel (sin simular clics DOM)
      toggleActivate,
      setMode,
      setDebounce,
      setUserNote,
      showOverlay,
      hideOverlay,
      toggleStealthVisibility,
    };
  };
})();
