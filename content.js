// content.js — Orquestador: estado compartido, constantes, inicialización y wiring de módulos
// Se carga último (después de sessionLog.js, captionCapture.js, aiClient.js, overlayUI.js)
// Cada módulo se registra como factory en window.__ia y se instancia aquí.

(function () {
  'use strict';

  // ══════════════════════════════════════
  //  CONSTANTES (inmutables, compartidas con todos los módulos)
  // ══════════════════════════════════════
  const C = {
    CAPTION_BUFFER_MAX: 250,
    AI_CONTEXT_MAX_LINES: 120,
    AI_CONTEXT_MAX_CHARS: 14000,
    AI_REQUEST_COOLDOWN_MS: 2000,
    SESSION_TRANSCRIPT_MAX_LINES: 4000,
    SESSION_DIGEST_MAX_CHARS: 2800,
    SESSION_PERSIST_DEBOUNCE_MS: 2000,
    SESSION_RESTORE_MAX_AGE_MS: 5 * 60 * 1000,
    SESSION_PROMPT_STORE_MAX: 12000,
    SESSION_AI_EVENTS_MAX: 80,
    STORAGE_KEY_MEETING_LOG: 'iaMeetingSessionLog'
  };

  // ══════════════════════════════════════
  //  ESTADO COMPARTIDO (mutable, un solo objeto referenciado por todos los módulos)
  // ══════════════════════════════════════
  const state = {
    config: null,
    isActive: false,
    overlay: null,
    captionBuffer: [],
    debounceTimer: null,
    isLoading: false,
    lastSentText: '',
    manualModeActive: false,
    lastUserSpokeId: null,
    nextCaptionLineId: 1,
    condensedProfile: null,
    suggestionHistory: [],
    meetingSessionId: '',
    sessionTranscript: [],
    sessionAiEvents: [],
    persistSessionTimer: null,
    lastAiRequestCompletedAt: 0,
    /** ID del caption más reciente del buffer la última vez que la IA generó una sugerencia */
    lastAiContextCaptionId: null,
    captionObserver: null,
    captionPollInterval: null,
    captionProcessRAF: null,
    seenBlockText: new WeakMap(),
    lastSeenTextsPerSpeaker: new Map(),
    /** Nota libre del candidato para la IA (overlay); no persiste en chrome.storage */
    userNote: '',
    /** Si true, el transcript hace scroll al final en cada actualización (comportamiento por defecto) */
    transcriptFollowLatest: true,
    /** Si true, el panel de transcripción está oculto (más espacio para sugerencia — ux-8) */
    transcriptCollapsed: false,
    /** Si true, el panel pop-out está abierto y el overlay in-page está oculto */
    panelActive: false
  };

  // ══════════════════════════════════════
  //  WIRING DE MÓDULOS
  //  Cada factory recibe (state, C, modules). Las referencias cruzadas se resuelven
  //  en tiempo de ejecución (late binding) porque `modules` se pasa por referencia
  //  y se completa antes de que cualquier función sea invocada.
  // ══════════════════════════════════════
  const modules = {};
  modules.sessionLog = window.__ia.createSessionLog(state, C, modules);
  modules.captionCapture = window.__ia.createCaptionCapture(state, C, modules);
  modules.ai = window.__ia.createAiClient(state, C, modules);
  modules.ui = window.__ia.createOverlayUI(state, C, modules);
  /** POC: registro de mensajes propios al chat de Meet (meetChatSelfLogPoc.js) */
  modules.chatSelfLogPoc = window.__ia.createMeetChatSelfLogPoc(state, C, modules);

  // ══════════════════════════════════════
  //  CONFIGURACIÓN
  // ══════════════════════════════════════
  function loadConfig(callback) {
    chrome.storage.local.get(['iaConfig'], (result) => {
      state.config = result.iaConfig || null;
      callback(state.config);
    });
  }

  // ══════════════════════════════════════
  //  INICIALIZACIÓN
  //  Meet: espera barra de reunión / subtítulos.
  //  Teams: en sala de espera (lobby) aún no existen colgar, mic ni subtítulos; se usa URL v2 o fallback por tiempo.
  // ══════════════════════════════════════
  function isTeamsWebHost() {
    const h = location.hostname;
    return h === 'teams.microsoft.com'
      || h === 'teams.live.com'
      || h === 'teams.cloud.microsoft'
      || h.endsWith('.teams.microsoft.com')
      || h.endsWith('.teams.cloud.microsoft');
  }

  /** true si parece la app web de Teams (v2, enlace de reunión, etc.) sin estar ya en llamada. */
  function isTeamsWebSurface() {
    if (!isTeamsWebHost()) return false;
    const p = (location.pathname + location.hash + location.search).toLowerCase();
    return p.includes('/v2')
        || p.includes('meetup-join')
        || p.includes('light-meetings')
        || p.includes('pre-join')
        || p.includes('prejoin');
  }

  function init() {
    let iaBootstrapped = false;
    let waitForPlatform = null;

    function bootstrap() {
      if (iaBootstrapped) return;
      iaBootstrapped = true;
      if (waitForPlatform) clearInterval(waitForPlatform);
      waitForPlatform = null;
      modules.chatSelfLogPoc.start();
      loadConfig((cfg) => {
        modules.ui.createOverlay();
        const statusIdle = isTeamsWebSurface() && !document.querySelector('[data-tid="hangup-button"]');
        modules.sessionLog.restoreSessionLog((restored) => {
          if (restored) {
            modules.ui.renderTranscript();
            modules.ui.updateStatus('Sesión previa restaurada (reciente)', 'idle');
            return;
          }
          if (cfg) {
            if (statusIdle) {
              modules.ui.updateStatus('Listo. Únete a la reunión, activa subtítulos y pulsa Activar.', 'idle');
            } else {
              modules.ui.updateStatus('Listo. Activa para comenzar.', 'idle');
            }
          } else {
            modules.ui.updateStatus('Configura el asistente primero', 'error');
          }
        });
      });
    }

    waitForPlatform = setInterval(() => {
      if (document.querySelector('[data-call-ended]') !== null ||
          document.querySelector('[data-meeting-title]') !== null ||
          document.querySelector('[data-allocation-index]') !== null ||
          document.querySelector('button[aria-label*="camera" i]') !== null ||
          document.querySelector('button[aria-label*="cámara" i]') !== null ||
          document.querySelector('button[aria-label*="mute" i]') !== null ||
          document.querySelector('button[aria-label*="silenciar" i]') !== null ||
          document.querySelector('button[aria-label*="micrófono" i]') !== null ||
          document.querySelector('[jscontroller="kAPMuc"]') !== null ||
          document.querySelector('.vNKgIf') !== null ||
          document.querySelector('[data-tid="hangup-button"]') !== null ||
          document.querySelector('[data-tid="microphone-button"]') !== null ||
          document.querySelector('[data-tid="call-controls"]') !== null ||
          document.querySelector('[data-tid="closed-captions-v2-items-renderer"]') !== null ||
          (isTeamsWebSurface() && document.body)) {
        bootstrap();
      }
    }, 1500);

    // Teams: si la URL no coincide con heurística pero sigues en el host, forzar arranque (SPA lenta o URL atípica)
    if (isTeamsWebHost()) {
      setTimeout(() => {
        if (!iaBootstrapped) {
          bootstrap();
        }
      }, 10000);
    }

    // Escuchar cambios de config desde el popup y comandos del panel pop-out
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'TOGGLE_OVERLAY_STEALTH') {
        modules.ui.toggleStealthVisibility();
        return;
      }

      if (msg.type === 'CONFIG_UPDATED') {
        const oldCv = state.config?.cvProfile || '';
        const oldJob = state.config?.jobDescription || '';
        loadConfig((newCfg) => {
          const cvChanged = (newCfg?.cvProfile || '') !== oldCv;
          const jobChanged = (newCfg?.jobDescription || '') !== oldJob;
          if ((cvChanged || jobChanged) && state.condensedProfile) {
            state.condensedProfile = null;
            if (state.isActive) {
              modules.ai.generateCondensedProfile().then(() => {
                modules.ui.updateStatus('Perfil re-condensado', 'active');
              });
            } else {
              modules.ui.updateStatus('Config actualizada — perfil se re-condensará al activar', 'idle');
            }
          } else {
            modules.ui.updateStatus('Config actualizada', state.isActive ? 'active' : 'idle');
          }
        });
      }

      if (msg.type === 'IA_PANEL_READY') {
        state.panelActive = true;
        modules.ui.sendPanelUpdate();
      }

      if (msg.type === 'IA_PANEL_CLOSED') {
        state.panelActive = false;
        if (state.overlay) state.overlay.style.display = 'flex';
      }

      if (msg.type === 'IA_PANEL_COMMAND') {
        handlePanelCommand(msg.command, msg.data);
      }
    });

    // Watcher throttleado para detectar aparición del contenedor de subtítulos
    let lastCaptionRoot = null;
    let watcherTimer = null;
    const WATCHER_THROTTLE_MS = 500;
    const captionContainerWatcher = new MutationObserver(() => {
      if (!state.isActive) return;
      if (watcherTimer) return;
      watcherTimer = setTimeout(() => {
        watcherTimer = null;
        const captionRoot = document.querySelector('[aria-label="Subtítulos"]')
                         || document.querySelector('[aria-label="Captions"]')
                         || document.querySelector('.vNKgIf')
                         || document.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]')
                         || document.querySelector('.fui-ChatMessageCompact')
                         || document.querySelector('[data-tid="closed-captions-v2-items-renderer"]');
        if (captionRoot && captionRoot !== lastCaptionRoot) {
          lastCaptionRoot = captionRoot;
          modules.captionCapture.startCaptionObserver();
          modules.ui.updateStatus('Subtítulos detectados', 'active');
        }
      }, WATCHER_THROTTLE_MS);
    });
    captionContainerWatcher.observe(document.body, { childList: true, subtree: true });
  }

  function handlePanelCommand(command, data) {
    switch (command) {
      case 'toggleActivate':
        modules.ui.toggleActivate();
        break;
      case 'requestSuggestion':
        state.lastSentText = '';
        modules.ai.requestSuggestion();
        break;
      case 'setMode':
        modules.ui.setMode(!!data?.manual);
        break;
      case 'setDebounce':
        if (data?.ms != null) modules.ui.setDebounce(data.ms);
        break;
      case 'setNote':
        modules.ui.setUserNote(data?.text || '');
        break;
      case 'downloadLog':
        modules.sessionLog.downloadSessionLogFile();
        modules.ui.updateStatus('Registro exportado (.txt)', 'active');
        break;
      case 'dockBack':
        state.panelActive = false;
        modules.ui.showOverlay();
        break;
    }
    setTimeout(() => modules.ui.sendPanelUpdate(), 150);
  }

  function cleanup() {
    modules.captionCapture.stopCaptionObserver();
    clearTimeout(state.debounceTimer);
  }

  window.addEventListener('beforeunload', cleanup);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.isActive) {
      modules.captionCapture.stopCaptionObserver();
    } else if (document.visibilityState === 'visible' && state.isActive) {
      modules.captionCapture.startCaptionObserver();
    }
  });

  setTimeout(init, 2000);

})();
