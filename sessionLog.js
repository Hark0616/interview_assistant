// sessionLog.js — Persistencia, transcripción de sesión, eventos, uso y descarga
// Factory: window.__ia.createSessionLog(state, C, modules)
// Dependencias externas: chrome.storage.local

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  window.__ia.createSessionLog = function (state, C, _modules) {

    function emptyUsage() {
      return {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        cost: 0
      };
    }

    function ensureUsage() {
      if (!state.sessionUsage || typeof state.sessionUsage !== 'object') {
        state.sessionUsage = emptyUsage();
      }
      return state.sessionUsage;
    }

    function getMeetingCodeFromUrl() {
      const meetMatch = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      if (meetMatch) return meetMatch[1];
      const hashPath = window.location.hash + window.location.pathname;
      const teamsMatch =
        hashPath.match(/meetup-join[^/]*\/([^/&?#]{8,})/i)
        || window.location.pathname.match(/\/meet\/([^/?#]+)/i);
      if (teamsMatch) return teamsMatch[1].slice(0, 20);
      const h = location.hostname;
      if (h.includes('teams')) return 'teams';
      return 'meet';
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
        transcript: state.sessionTranscript.slice(-C.SESSION_TRANSCRIPT_MAX_LINES),
        aiEvents: state.sessionAiEvents.slice(-C.SESSION_AI_EVENTS_MAX),
        usage: ensureUsage()
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
      const cleanText = String(text || '').slice(0, 2000);
      state.sessionTranscript.push({ t: Date.now(), speaker, role, text: cleanText, captionId: captionId ?? null });
      trimSessionTranscript();
      schedulePersistSessionLog();
      _modules.memoryLedger?.notifyTranscriptChanged?.();
    }

    function syncSessionTranscriptLast(speaker, role, text, captionId) {
      const row = state.sessionTranscript[state.sessionTranscript.length - 1];
      const cleanText = String(text || '').slice(0, 2000);
      if (row && row.speaker === speaker) {
        row.text = cleanText;
        row.t = Date.now();
        row.role = role;
        if (captionId != null) row.captionId = captionId;
        schedulePersistSessionLog();
        _modules.memoryLedger?.notifyTranscriptChanged?.();
      } else {
        pushSessionTranscriptLine(speaker, role, cleanText, captionId);
      }
    }

    function resetSessionLog() {
      state.meetingSessionId = `${getMeetingCodeFromUrl()}-${Date.now()}`;
      state.sessionTranscript = [];
      state.sessionAiEvents = [];
      state.sessionUsage = emptyUsage();
      state.sessionWasRestored = false;
      state.captionBuffer = [];
      state.lastUserSpokeId = null;
      state.lastAiContextCaptionId = null;
      state.nextCaptionLineId = 1;
      if (state.persistSessionTimer) clearTimeout(state.persistSessionTimer);
      state.persistSessionTimer = null;
      flushPersistSessionLog();
    }

    function ensureSessionLog() {
      if (state.meetingSessionId) return false;
      resetSessionLog();
      return true;
    }

    function restoreSessionLog(callback) {
      chrome.storage.local.get([C.STORAGE_KEY_MEETING_LOG], (result) => {
        const data = result?.[C.STORAGE_KEY_MEETING_LOG];
        if (!data) return callback?.(false);
        if (data.meetingCode !== getMeetingCodeFromUrl()) return callback?.(false);
        if (!data.updatedAt || Date.now() - data.updatedAt > C.SESSION_RESTORE_MAX_AGE_MS) {
          return callback?.(false);
        }

        state.sessionTranscript = Array.isArray(data.transcript)
          ? data.transcript.slice(-C.SESSION_TRANSCRIPT_MAX_LINES)
          : [];
        state.sessionAiEvents = Array.isArray(data.aiEvents)
          ? data.aiEvents.slice(-C.SESSION_AI_EVENTS_MAX)
          : [];
        state.meetingSessionId = data.meetingSessionId || `${getMeetingCodeFromUrl()}-${Date.now()}`;
        state.sessionUsage = { ...emptyUsage(), ...(data.usage || {}) };
        state.sessionWasRestored = true;

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

        callback?.(true, {
          memory: String(data.memory || ''),
          memoryProcessedCaptionId: data.memoryProcessedCaptionId ?? null,
          memoryUpdatedAt: Number(data.memoryUpdatedAt) || Number(data.updatedAt) || Date.now()
        });
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

    function tokenizeForRetrieval(text) {
      const stopWords = new Set([
        'para', 'como', 'pero', 'porque', 'esta', 'este', 'esto', 'desde', 'sobre', 'entre',
        'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where', 'your', 'about'
      ]);
      return new Set(String(text || '')
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9+#.]+/)
        .filter((token) => token.length >= 4 && !stopWords.has(token)));
    }

    function findRelevantTranscriptFragments(queryText, excludedCaptionIds) {
      const terms = tokenizeForRetrieval(queryText);
      if (terms.size === 0) return [];
      return state.sessionTranscript
        .filter((row) => !excludedCaptionIds.has(row.captionId))
        .map((row) => {
          const rowTerms = tokenizeForRetrieval(row.text);
          let score = 0;
          for (const term of terms) {
            if (rowTerms.has(term)) score += 1;
          }
          return { row, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.row.t - a.row.t)
        .slice(0, 4)
        .sort((a, b) => a.row.t - b.row.t)
        .map((item) => item.row);
    }

    function buildTranscriptContextForPrompt(queryText = '') {
      const prior = getPriorSessionLinesForDigest();
      const recentRows = prior.slice(-C.SESSION_RECENT_MAX_LINES);
      const recentIds = new Set(recentRows.map((row) => row.captionId));
      const relevantRows = findRelevantTranscriptFragments(queryText, recentIds);
      let recentText = formatTranscriptLines(recentRows);
      if (recentText.length > C.SESSION_RECENT_MAX_CHARS) {
        recentText = '…(ventana reciente recortada)…\n' +
          recentText.slice(-C.SESSION_RECENT_MAX_CHARS);
      }

      const sections = [];
      if (recentText) sections.push(`VENTANA RECIENTE LITERAL:\n${recentText}`);
      if (relevantRows.length) {
        sections.push(`FRAGMENTOS ANTERIORES RELEVANTES:\n${formatTranscriptLines(relevantRows)}`);
      }

      const combined = sections.join('\n\n');
      if (combined.length <= C.SESSION_DIGEST_MAX_CHARS) return combined;
      return combined.slice(0, C.SESSION_DIGEST_MAX_CHARS);
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

    function recordApiUsage(usage, purpose = 'suggestion') {
      if (!usage || typeof usage !== 'object') return;
      const totals = ensureUsage();
      const add = (key) => {
        const amount = Number(usage[key]);
        if (Number.isFinite(amount) && amount >= 0) totals[key] += amount;
      };
      totals.requests += 1;
      add('promptTokens');
      add('completionTokens');
      add('reasoningTokens');
      add('cachedTokens');
      add('cacheWriteTokens');
      add('cost');
      state.sessionAiEvents.push({
        t: Date.now(),
        kind: 'usage',
        purpose,
        usage: { ...usage }
      });
      if (state.sessionAiEvents.length > C.SESSION_AI_EVENTS_MAX) state.sessionAiEvents.shift();
      flushPersistSessionLog();
      _modules.ui?.updateUsage?.();
    }

    function formatUsageSummary() {
      const usage = ensureUsage();
      const compact = (value) => Number(value || 0).toLocaleString('es-CO');
      return `${usage.requests} req · ${compact(usage.promptTokens)} in · ` +
        `${compact(usage.completionTokens)} out · $${Number(usage.cost || 0).toFixed(4)}`;
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
        `Reunión: ${getMeetingCodeFromUrl()}`,
        `URL: ${window.location.href}`,
        `Generado: ${iso(Date.now())}`,
        `Uso: ${formatUsageSummary()}`,
        `Tokens de razonamiento: ${ensureUsage().reasoningTokens}`,
        `Tokens cacheados: ${ensureUsage().cachedTokens}`,
        '',
        '--- Transcripción (subtítulos capturados en esta activación) ---',
        ''
      ];
      for (const l of state.sessionTranscript) {
        const role = l.role === 'me' ? 'TÚ' : 'ENTREVISTADOR';
        lines.push(`[${iso(l.t)}] [${role}] ${l.speaker || '?'}: ${l.text}`);
      }
      const memorySnapshot = _modules.memoryLedger?.formatMarkdown?.();
      if (memorySnapshot) {
        lines.push('', '--- Memoria verificable de la entrevista ---', '', memorySnapshot.trim());
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
        } else if (e.kind === 'usage') {
          const usage = e.usage || {};
          lines.push(
            `[${iso(e.t)}] USO ${e.purpose || 'request'}: ` +
            `${usage.promptTokens || 0} in, ${usage.completionTokens || 0} out, ` +
            `${usage.cachedTokens || 0} cache, $${Number(usage.cost || 0).toFixed(6)}`
          );
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
      a.download = `ia-session-${getMeetingCodeFromUrl()}-${Date.now()}.txt`;
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
      ensureSessionLog,
      restoreSessionLog,
      flushPersistSessionLog,
      findLastUserSpokeIndex,
      buildTranscriptContextForPrompt,
      recordIaActivation,
      recordIaResponse,
      recordApiUsage,
      formatUsageSummary,
      recordIaError,
      downloadSessionLogFile
    };
  };
})();
