// sessionLog.js — Persistencia, transcripción de sesión, digest y descarga
// Factory: window.__ia.createSessionLog(state, C, modules)
// Dependencias externas: chrome.storage.local

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.createSessionLog = function (state, C, _modules) {

    function getMeetingCodeFromUrl() {
      const m = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      return m ? m[1] : 'meet';
    }

    function trimSessionTranscript() {
      while (state.sessionTranscript.length > C.SESSION_TRANSCRIPT_MAX_LINES) {
        state.sessionTranscript.shift();
      }
    }

    function schedulePersistSessionLog() {
      if (state.persistSessionTimer) clearTimeout(state.persistSessionTimer);
      state.persistSessionTimer = setTimeout(flushPersistSessionLog, C.SESSION_PERSIST_DEBOUNCE_MS);
    }

    function flushPersistSessionLog() {
      state.persistSessionTimer = null;
      const payload = {
        meetingSessionId: state.meetingSessionId,
        meetingCode: getMeetingCodeFromUrl(),
        meetingUrl: window.location.href,
        updatedAt: Date.now(),
        transcript: state.sessionTranscript.slice(-800),
        aiEvents: state.sessionAiEvents.slice(-60)
      };
      try {
        chrome.storage.local.set({ [C.STORAGE_KEY_MEETING_LOG]: payload }, () => {
          if (chrome.runtime?.lastError) {
            console.warn('[sessionLog] No se pudo persistir el log:', chrome.runtime.lastError.message);
          }
        });
      } catch (err) {
        console.warn('[sessionLog] Error inesperado al persistir:', err);
      }
    }

    function pushSessionTranscriptLine(speaker, role, text, captionId) {
      state.sessionTranscript.push({ t: Date.now(), speaker, role, text, captionId: captionId ?? null });
      trimSessionTranscript();
      schedulePersistSessionLog();
    }

    function syncSessionTranscriptLast(speaker, role, text, captionId) {
      const row = state.sessionTranscript[state.sessionTranscript.length - 1];
      if (row && row.speaker === speaker) {
        row.text = text;
        row.t = Date.now();
        row.role = role;
        if (captionId != null) row.captionId = captionId;
        schedulePersistSessionLog();
      } else {
        pushSessionTranscriptLine(speaker, role, text, captionId);
      }
    }

    function resetSessionLog() {
      state.meetingSessionId = `${getMeetingCodeFromUrl()}-${Date.now()}`;
      state.sessionTranscript = [];
      state.sessionAiEvents = [];
      state.captionBuffer = [];
      state.lastUserSpokeId = null;
      state.lastAiContextCaptionId = null;
      state.nextCaptionLineId = 1;
      if (state.persistSessionTimer) clearTimeout(state.persistSessionTimer);
      state.persistSessionTimer = null;
      flushPersistSessionLog();
    }

    function restoreSessionLog(callback) {
      chrome.storage.local.get([C.STORAGE_KEY_MEETING_LOG], (result) => {
        const data = result?.[C.STORAGE_KEY_MEETING_LOG];
        if (!data) return callback?.(false);
        if (data.meetingCode !== getMeetingCodeFromUrl()) return callback?.(false);
        if (!data.updatedAt || Date.now() - data.updatedAt > C.SESSION_RESTORE_MAX_AGE_MS) {
          return callback?.(false);
        }

        state.sessionTranscript = Array.isArray(data.transcript) ? data.transcript.slice(-800) : [];
        state.sessionAiEvents = Array.isArray(data.aiEvents) ? data.aiEvents.slice(-60) : [];
        state.meetingSessionId = data.meetingSessionId || `${getMeetingCodeFromUrl()}-${Date.now()}`;

        const recentTranscript = state.sessionTranscript.slice(-C.CAPTION_BUFFER_MAX);
        state.captionBuffer = recentTranscript.map((row, idx) => ({
          id: row.captionId ?? idx + 1,
          speaker: row.speaker || '',
          text: row.text || '',
          role: row.role === 'me' ? 'me' : 'interviewer',
          timestamp: row.t || Date.now()
        }));
        const maxId = state.captionBuffer.reduce((m, row) => Math.max(m, Number(row.id) || 0), 0);
        state.nextCaptionLineId = maxId + 1;
        const lastMe = [...state.captionBuffer].reverse().find((row) => row.role === 'me');
        state.lastUserSpokeId = lastMe?.id ?? null;
        state.lastAiContextCaptionId = null;

        callback?.(true);
      });
    }

    function formatTranscriptLines(lines) {
      return lines
        .map((l) => {
          const label = l.role === 'me' ? '[TÚ]' : '[ENTREVISTADOR]';
          const who = l.speaker ? `${l.speaker}` : '';
          return `${label}${who ? ' ' + who : ''}: ${l.text}`;
        })
        .join('\n');
    }

    function findLastUserSpokeIndex() {
      if (state.lastUserSpokeId == null) return -1;
      return state.captionBuffer.findIndex((line) => line.id === state.lastUserSpokeId);
    }

    function getPriorSessionLinesForDigest() {
      if (state.sessionTranscript.length === 0 || state.captionBuffer.length === 0) return [];
      if (state.lastUserSpokeId == null) return [];
      const transcriptIdx = state.sessionTranscript.findIndex(
        (row) => row.captionId === state.lastUserSpokeId
      );
      if (transcriptIdx < 0) return [];
      return state.sessionTranscript.slice(0, transcriptIdx + 1);
    }

    function buildSessionDigestForPrompt() {
      const prior = getPriorSessionLinesForDigest();
      if (prior.length === 0 && state.sessionAiEvents.length === 0) return '';

      let transcriptPart = formatTranscriptLines(prior);
      const budget = Math.floor(C.SESSION_DIGEST_MAX_CHARS * 0.72);
      if (transcriptPart.length > budget) {
        transcriptPart = '…(recorte del inicio de la reunión)…\n' + transcriptPart.slice(-budget);
      }

      const activations = state.sessionAiEvents.filter((e) => e.kind === 'activation').length;
      const header = activations > 0
        ? `Consultas IA previas en esta sesión: ${activations}\n\n`
        : '';

      const responses = state.sessionAiEvents.filter((e) => e.kind === 'response').slice(-2);
      let aiPart = '';
      if (responses.length) {
        aiPart =
          '\n\nÚltimas sugerencias IA (no las repitas; solo coherencia):\n' +
          responses.map((r) => r.text.slice(0, 500)).join('\n---\n');
      }

      const combined = header + transcriptPart + aiPart;
      if (combined.length <= C.SESSION_DIGEST_MAX_CHARS) return combined;
      return combined.slice(-C.SESSION_DIGEST_MAX_CHARS);
    }

    function recordIaActivation(promptText) {
      state.sessionAiEvents.push({
        t: Date.now(),
        kind: 'activation',
        text: promptText.slice(0, C.SESSION_PROMPT_STORE_MAX)
      });
      if (state.sessionAiEvents.length > C.SESSION_AI_EVENTS_MAX) state.sessionAiEvents.shift();
      flushPersistSessionLog();
    }

    function recordIaResponse(text) {
      state.sessionAiEvents.push({
        t: Date.now(),
        kind: 'response',
        text: String(text).slice(0, C.SESSION_PROMPT_STORE_MAX)
      });
      if (state.sessionAiEvents.length > C.SESSION_AI_EVENTS_MAX) state.sessionAiEvents.shift();
      flushPersistSessionLog();
    }

    function recordIaError(msg) {
      state.sessionAiEvents.push({
        t: Date.now(),
        kind: 'error',
        text: String(msg).slice(0, 2000)
      });
      if (state.sessionAiEvents.length > C.SESSION_AI_EVENTS_MAX) state.sessionAiEvents.shift();
      flushPersistSessionLog();
    }

    function formatSessionLogForDownload() {
      const iso = (t) => new Date(t).toISOString();
      const lines = [
        '=== Interview Assistant — registro de reunión ===',
        `Sesión: ${state.meetingSessionId || '(sin id)'}`,
        `Meet: ${getMeetingCodeFromUrl()}`,
        `URL: ${window.location.href}`,
        `Generado: ${iso(Date.now())}`,
        '',
        '--- Transcripción (subtítulos capturados en esta activación) ---',
        ''
      ];
      for (const l of state.sessionTranscript) {
        const role = l.role === 'me' ? 'TÚ' : 'ENTREVISTADOR';
        lines.push(`[${iso(l.t)}] [${role}] ${l.speaker || '?'}: ${l.text}`);
      }
      lines.push('', '--- Eventos IA ---', '');
      for (const e of state.sessionAiEvents) {
        if (e.kind === 'activation') {
          lines.push(`[${iso(e.t)}] *** IA ACTIVADA — contexto enviado ***`);
          lines.push(e.text || '');
          lines.push('');
        } else if (e.kind === 'response') {
          lines.push(`[${iso(e.t)}] --- Sugerencia IA ---`);
          lines.push(e.text || '');
          lines.push('');
        } else {
          lines.push(`[${iso(e.t)}] ERROR: ${e.text || ''}`);
          lines.push('');
        }
      }
      return lines.join('\n');
    }

    function downloadSessionLogFile() {
      const body = formatSessionLogForDownload();
      const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `meet-ia-${getMeetingCodeFromUrl()}-${Date.now()}.txt`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    return {
      getMeetingCodeFromUrl,
      pushSessionTranscriptLine,
      syncSessionTranscriptLast,
      resetSessionLog,
      restoreSessionLog,
      flushPersistSessionLog,
      findLastUserSpokeIndex,
      buildSessionDigestForPrompt,
      recordIaActivation,
      recordIaResponse,
      recordIaError,
      downloadSessionLogFile
    };
  };
})();
