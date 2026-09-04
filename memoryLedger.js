// memoryLedger.js — Memoria semántica incremental, aislada por sesión.
// Factory: window.__ia.createMemoryLedger(state, C, modules)
// La transcripción de sessionLog es la única fuente automática de hechos.

(function () {
  'use strict';
  window.__ia = window.__ia || {};

  const CATEGORY_LABELS = {
    'candidate-fact': 'Hechos del candidato',
    'interviewer-context': 'Contexto del entrevistador',
    'story-used': 'Historias utilizadas',
    'technology-metric': 'Tecnologías y métricas',
    commitment: 'Compromisos',
    pending: 'Pendientes',
    style: 'Idioma, tono y estilo'
  };
  const CATEGORIES = new Set(Object.keys(CATEGORY_LABELS));
  const CANDIDATE_SOURCE_CATEGORIES = new Set([
    'candidate-fact', 'story-used', 'technology-metric', 'commitment'
  ]);
  const INTERVIEWER_SOURCE_CATEGORIES = new Set(['interviewer-context', 'pending']);
  const CONFIDENCES = new Set(['confirmed', 'inferred']);
  const MEMORY_MODES = new Set(['off', 'existing', 'automatic']);
  const MAX_TEXT_CHARS = 1000;
  const MAX_SOURCE_IDS = 20;
  const MAX_OPERATIONS = 80;

  window.__ia.createMemoryLedger = function (state, C, modules) {
    let updateTimer = null;
    let persistTimer = null;
    let activeRequestId = null;

    function emptyLedger() {
      return {
        version: 1,
        meetingSessionId: state.meetingSessionId || '',
        bullets: [],
        processedCaptionId: null,
        processedCaptionRevisions: {},
        pendingSince: null,
        questionsSinceUpdate: 0,
        updatedAt: Date.now()
      };
    }

    function ensureLedger() {
      if (!state.memoryLedger || state.memoryLedger.meetingSessionId !== state.meetingSessionId) {
        state.memoryLedger = emptyLedger();
      }
      return state.memoryLedger;
    }

    function getMode() {
      const configured = state.config?.memoryMode;
      return MEMORY_MODES.has(configured) ? configured : 'automatic';
    }

    function latestCaptionId() {
      return state.sessionTranscript.reduce(
        (max, row) => Math.max(max, Number(row.captionId) || 0),
        0
      );
    }

    function captionRevision(row) {
      const revision = Number(row?.revision);
      return Number.isInteger(revision) && revision > 0 ? revision : 1;
    }

    function processedRevision(ledger, captionId) {
      const revisions = ledger.processedCaptionRevisions;
      if (revisions && Object.prototype.hasOwnProperty.call(revisions, captionId)) {
        const revision = Number(revisions[captionId]);
        if (Number.isInteger(revision) && revision > 0) return revision;
      }
      // Ledgers anteriores a las revisiones solo conocían el cursor numérico;
      // sus captions ya procesados equivalen a la primera revisión.
      return Number(captionId) <= (Number(ledger.processedCaptionId) || 0) ? 1 : 0;
    }

    function markRowsProcessed(ledger, rows, lastCaptionId = null) {
      if (!ledger.processedCaptionRevisions || typeof ledger.processedCaptionRevisions !== 'object') {
        ledger.processedCaptionRevisions = {};
      }
      for (const row of rows || []) {
        const captionId = Number(row.captionId);
        if (!Number.isFinite(captionId)) continue;
        ledger.processedCaptionRevisions[captionId] = captionRevision(row);
      }
      const rowMax = (rows || []).reduce(
        (max, row) => Math.max(max, Number(row.captionId) || 0),
        0
      );
      const requestedMax = Number(lastCaptionId) || 0;
      ledger.processedCaptionId = Math.max(
        Number(ledger.processedCaptionId) || 0,
        rowMax,
        requestedMax
      );
    }

    function skipPendingWhilePaused() {
      if (!state.meetingSessionId) return;
      const ledger = ensureLedger();
      const latest = latestCaptionId();
      markRowsProcessed(ledger, state.sessionTranscript, latest);
      ledger.pendingSince = null;
      ledger.questionsSinceUpdate = 0;
      schedulePersist();
    }

    function storageKey(sessionId = state.meetingSessionId) {
      return `${C.STORAGE_KEY_MEMORY_LEDGER_PREFIX}${sessionId}`;
    }

    function storageGet(key) {
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (result) => resolve(result?.[key] || null));
      });
    }

    function storageSet(key, value) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime?.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    }

    function cloneBullet(bullet) {
      return {
        id: String(bullet.id || ''),
        category: String(bullet.category || ''),
        text: String(bullet.text || '').slice(0, MAX_TEXT_CHARS),
        sourceCaptionIds: Array.isArray(bullet.sourceCaptionIds)
          ? [...new Set(bullet.sourceCaptionIds.map(Number).filter(Number.isFinite))].slice(0, MAX_SOURCE_IDS)
          : [],
        sourceTimestamps: Array.isArray(bullet.sourceTimestamps)
          ? bullet.sourceTimestamps.map(Number).filter(Number.isFinite).slice(0, MAX_SOURCE_IDS)
          : [],
        confidence: CONFIDENCES.has(bullet.confidence) ? bullet.confidence : 'inferred',
        origin: ['model', 'manual', 'legacy'].includes(bullet.origin) ? bullet.origin : 'model',
        pinned: !!bullet.pinned,
        active: bullet.active !== false,
        createdAt: Number(bullet.createdAt) || Date.now(),
        updatedAt: Number(bullet.updatedAt) || Number(bullet.createdAt) || Date.now()
      };
    }

    function sanitizeStoredLedger(raw) {
      const ledger = emptyLedger();
      if (!raw || typeof raw !== 'object') return ledger;
      ledger.version = 1;
      ledger.meetingSessionId = state.meetingSessionId;
      ledger.bullets = Array.isArray(raw.bullets)
        ? raw.bullets.map(cloneBullet).filter((b) => b.id && CATEGORIES.has(b.category) && b.text)
        : [];
      ledger.processedCaptionId = Number.isFinite(Number(raw.processedCaptionId))
        ? Number(raw.processedCaptionId)
        : null;
      ledger.processedCaptionRevisions = raw.processedCaptionRevisions &&
        typeof raw.processedCaptionRevisions === 'object'
        ? Object.fromEntries(Object.entries(raw.processedCaptionRevisions)
          .map(([id, revision]) => [id, Number(revision)])
          .filter(([id, revision]) => Number.isFinite(Number(id)) && Number.isInteger(revision) && revision > 0))
        : {};
      ledger.pendingSince = Number.isFinite(Number(raw.pendingSince)) ? Number(raw.pendingSince) : null;
      ledger.questionsSinceUpdate = Math.max(0, Number(raw.questionsSinceUpdate) || 0);
      ledger.updatedAt = Number(raw.updatedAt) || Date.now();
      return ledger;
    }

    function normalizeText(text) {
      return String(text || '')
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9+#.]+/g, ' ')
        .trim();
    }

    function makeId() {
      if (globalThis.crypto?.randomUUID) return `mem-${crypto.randomUUID()}`;
      return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function legacyCategoryForHeading(heading) {
      const h = normalizeText(heading);
      if (h.includes('historia')) return 'story-used';
      if (h.includes('tecnologia') || h.includes('metrica') || h.includes('experiencia')) return 'technology-metric';
      if (h.includes('compromiso') || h.includes('afirmacion')) return 'commitment';
      if (h.includes('pendiente') || h.includes('follow')) return 'pending';
      if (h.includes('idioma') || h.includes('tono') || h.includes('estilo')) return 'style';
      if (h.includes('tema') || h.includes('pregunta')) return 'interviewer-context';
      return 'candidate-fact';
    }

    function migrateLegacyMemory(memory, legacyProcessedCaptionId) {
      const text = String(memory || '').trim();
      if (!text) return [];
      const now = Date.now();
      let category = 'candidate-fact';
      const bullets = [];
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/^[-*•]\s*/, '').trim();
        if (!line) continue;
        const looksLikeHeading = line.length < 100 && line === line.toLocaleUpperCase();
        if (looksLikeHeading) {
          category = legacyCategoryForHeading(line);
          continue;
        }
        bullets.push({
          id: makeId(),
          category,
          text: line.slice(0, MAX_TEXT_CHARS),
          sourceCaptionIds: [],
          sourceTimestamps: [],
          confidence: 'inferred',
          origin: 'legacy',
          pinned: false,
          active: true,
          createdAt: now,
          updatedAt: now
        });
      }
      if (bullets.length === 0) {
        bullets.push({
          id: makeId(), category: 'candidate-fact', text: text.slice(0, MAX_TEXT_CHARS),
          sourceCaptionIds: [], sourceTimestamps: [], confidence: 'inferred', origin: 'legacy',
          pinned: false, active: true, createdAt: now, updatedAt: now
        });
      }
      const ledger = ensureLedger();
      ledger.processedCaptionId = Number.isFinite(Number(legacyProcessedCaptionId))
        ? Number(legacyProcessedCaptionId)
        : ledger.processedCaptionId;
      return bullets;
    }

    async function restoreAndMigrate(legacy = null) {
      if (!state.meetingSessionId) return false;
      cancelUpdate('Cambio de sesión.');
      const saved = await storageGet(storageKey());
      if (saved) {
        state.memoryLedger = sanitizeStoredLedger(saved);
      } else {
        state.memoryLedger = emptyLedger();
        const migrated = migrateLegacyMemory(legacy?.memory, legacy?.memoryProcessedCaptionId);
        state.memoryLedger.bullets.push(...migrated);
        if (legacy?.memoryUpdatedAt) state.memoryLedger.updatedAt = Number(legacy.memoryUpdatedAt);
      }
      trimRecords();
      await persistNow();
      setStatus('idle', saved ? 'Memoria restaurada' : 'Memoria lista');
      notifyTranscriptChanged();
      render();
      return !!saved;
    }

    async function resetForSession() {
      cancelUpdate('Nueva sesión.');
      state.memoryLedger = emptyLedger();
      await persistNow();
      setStatus('idle', 'Memoria lista');
      render();
    }

    async function persistNow() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      if (!state.meetingSessionId) return;
      const ledger = ensureLedger();
      ledger.updatedAt = Date.now();
      try {
        await storageSet(storageKey(), ledger);
      } catch (err) {
        console.warn('[memoryLedger] No se pudo persistir:', err.message);
      }
    }

    function schedulePersist() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => { void persistNow(); }, C.SESSION_PERSIST_DEBOUNCE_MS);
    }

    function setStatus(status, text) {
      state.memoryLedgerStatus = { status, text: String(text || ''), updatedAt: Date.now() };
      render();
    }

    function render() {
      modules.ui?.renderMemory?.();
    }

    function pendingRows() {
      const ledger = ensureLedger();
      const processed = Number(ledger.processedCaptionId) || 0;
      const rows = state.sessionTranscript
        .filter((row) => {
          const captionId = Number(row.captionId);
          return captionId > processed || captionRevision(row) > processedRevision(ledger, captionId);
        })
        .sort((a, b) => Number(a.captionId) - Number(b.captionId));
      const selected = [];
      let chars = 0;
      for (const row of rows) {
        const size = String(row.text || '').length + 80;
        if (selected.length && chars + size > C.MEMORY_UPDATE_MAX_TRANSCRIPT_CHARS) break;
        selected.push(row);
        chars += size;
      }
      return selected;
    }

    function notifyTranscriptChanged() {
      if (!state.meetingSessionId) return;
      if (getMode() !== 'automatic') {
        skipPendingWhilePaused();
        return;
      }
      const ledger = ensureLedger();
      if (pendingRows().length === 0) {
        ledger.pendingSince = null;
        return;
      }
      if (!ledger.pendingSince) {
        ledger.pendingSince = Date.now();
        schedulePersist();
      }
      scheduleUpdate(Math.max(0, C.SESSION_MEMORY_UPDATE_INTERVAL_MS - (Date.now() - ledger.pendingSince)));
    }

    function noteResponseCompleted() {
      if (getMode() !== 'automatic') {
        skipPendingWhilePaused();
        return;
      }
      const ledger = ensureLedger();
      ledger.questionsSinceUpdate += 1;
      schedulePersist();
      if (ledger.questionsSinceUpdate >= C.SESSION_MEMORY_UPDATE_QUESTIONS) {
        scheduleUpdate(C.MEMORY_UPDATE_DELAY_MS);
      } else {
        notifyTranscriptChanged();
      }
    }

    function scheduleUpdate(delayMs = C.MEMORY_UPDATE_DELAY_MS) {
      if (getMode() !== 'automatic') return;
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = setTimeout(() => {
        updateTimer = null;
        void requestUpdate();
      }, Math.max(0, delayMs));
    }

    function cancelUpdate(reason = 'Solicitud principal iniciada.') {
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = null;
      if (!activeRequestId) return;
      const requestId = activeRequestId;
      activeRequestId = null;
      try {
        const cancellation = chrome.runtime.sendMessage({
          type: 'CANCEL_MEMORY_LEDGER_UPDATE',
          meetingSessionId: state.meetingSessionId,
          requestId,
          reason
        });
        cancellation?.catch?.(() => {});
      } catch { /* el service worker puede estar reiniciándose */ }
      setStatus('pending', 'Actualización pospuesta');
    }

    function setMode(mode) {
      const nextMode = MEMORY_MODES.has(mode) ? mode : 'automatic';
      cancelUpdate('Modo de memoria actualizado.');
      if (!state.config) state.config = {};
      state.config.memoryMode = nextMode;
      if (nextMode !== 'automatic') skipPendingWhilePaused();
      else notifyTranscriptChanged();
      chrome.storage.local.get(['iaConfig'], (result) => {
        chrome.storage.local.set({
          iaConfig: { ...(result.iaConfig || {}), memoryMode: nextMode }
        });
      });
      const labels = {
        off: 'Memoria desactivada',
        existing: 'Solo memoria existente',
        automatic: 'Memoria automática'
      };
      setStatus(nextMode === 'automatic' ? 'idle' : 'paused', labels[nextMode]);
      return nextMode;
    }

    function applyConfiguredMode() {
      cancelUpdate('Configuración de memoria actualizada.');
      if (getMode() !== 'automatic') skipPendingWhilePaused();
      else notifyTranscriptChanged();
      render();
    }

    function tokenize(text) {
      return new Set(normalizeText(text).split(/\s+/).filter((word) => word.length >= 4));
    }

    function lexicalScore(text, terms) {
      const words = tokenize(text);
      let score = 0;
      for (const term of terms) if (words.has(term)) score += 1;
      return score;
    }

    function selectExistingForUpdate(rows) {
      const terms = tokenize(rows.map((row) => row.text).join(' '));
      return ensureLedger().bullets
        .filter((bullet) => bullet.active)
        .map((bullet) => ({ bullet, score: lexicalScore(bullet.text, terms) }))
        .sort((a, b) => Number(b.bullet.pinned) - Number(a.bullet.pinned) || b.score - a.score || b.bullet.updatedAt - a.bullet.updatedAt)
        .slice(0, 100)
        .map(({ bullet }) => ({
          id: bullet.id, category: bullet.category, text: bullet.text,
          confidence: bullet.confidence, origin: bullet.origin, pinned: bullet.pinned,
          sourceCaptionIds: bullet.sourceCaptionIds
        }));
    }

    function buildUpdatePrompt(rows) {
      const existing = selectExistingForUpdate(rows);
      const captions = rows.map((row) => ({
        id: Number(row.captionId),
        role: row.role === 'me' ? 'me' : row.role === 'unknown' ? 'unknown' : 'interviewer',
        timestamp: Number(row.t) || Date.now(),
        speaker: String(row.speaker || ''),
        text: String(row.text || '')
      }));
      return `Actualiza un ledger factual de entrevista usando EXCLUSIVAMENTE los captions nuevos.\n` +
        `Devuelve JSON válido sin Markdown con esta forma: {"operations":[...]}.\n` +
        `Operaciones permitidas:\n` +
        `- add: {"op":"add","category":"...","text":"...","sourceCaptionIds":[1],"confidence":"confirmed|inferred"}\n` +
        `- update: {"op":"update","id":"...","category":"...","text":"...","sourceCaptionIds":[1],"confidence":"confirmed|inferred"}\n` +
        `- retire: {"op":"retire","id":"...","sourceCaptionIds":[1]}\n` +
        `Categorías: ${[...CATEGORIES].join(', ')}.\n` +
        `Reglas: no inventes; no uses sugerencias de IA; candidate-fact, story-used, technology-metric y commitment requieren fuentes role=me; ` +
        `interviewer-context y pending requieren fuentes role=interviewer; usa IDs existentes solo para update/retire; evita duplicados.\n\n` +
        `LEDGER ACTIVO (puede estar recortado):\n${JSON.stringify(existing)}\n\n` +
        `CAPTIONS NUEVOS:\n${JSON.stringify(captions)}`;
    }

    function parseOperations(text) {
      let raw = String(text || '').trim();
      if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.operations) || parsed.operations.length > MAX_OPERATIONS) {
        throw new Error('JSON de memoria sin operations válidas.');
      }
      return parsed.operations;
    }

    function validateSources(sourceIds, pendingMap, category) {
      if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > MAX_SOURCE_IDS) {
        throw new Error('Cada operación debe incluir entre 1 y 20 sourceCaptionIds.');
      }
      const ids = [...new Set(sourceIds.map(Number))];
      if (ids.some((id) => !Number.isFinite(id) || !pendingMap.has(id))) {
        throw new Error('Una operación referencia captions inexistentes o ya procesados.');
      }
      const rows = ids.map((id) => pendingMap.get(id));
      if (CANDIDATE_SOURCE_CATEGORIES.has(category) && !rows.some((row) => row.role === 'me')) {
        throw new Error(`La categoría ${category} requiere una fuente del candidato.`);
      }
      if (INTERVIEWER_SOURCE_CATEGORIES.has(category) && !rows.some((row) => row.role === 'interviewer')) {
        throw new Error(`La categoría ${category} requiere una fuente del entrevistador.`);
      }
      return ids;
    }

    function validateOperations(operations, rows) {
      const ledger = ensureLedger();
      const byId = new Map(ledger.bullets.map((bullet) => [bullet.id, bullet]));
      const pendingMap = new Map(rows.map((row) => [Number(row.captionId), row]));
      const targetedIds = new Set();
      return operations.map((operation) => {
        if (!operation || !['add', 'update', 'retire'].includes(operation.op)) {
          throw new Error('Operación de memoria desconocida.');
        }
        if (operation.op === 'retire') {
          const current = byId.get(String(operation.id || ''));
          if (!current) throw new Error('No existe el bullet que se intenta retirar.');
          if (current.pinned || current.origin === 'manual') return { op: 'ignore', current };
          if (targetedIds.has(current.id)) throw new Error('Un bullet no puede recibir operaciones conflictivas.');
          targetedIds.add(current.id);
          const sourceCaptionIds = validateSources(operation.sourceCaptionIds, pendingMap, current.category);
          return { op: 'retire', current, sourceCaptionIds };
        }
        if (operation.op === 'update') {
          const protectedBullet = byId.get(String(operation.id || ''));
          if (!protectedBullet) throw new Error('No existe el bullet que se intenta actualizar.');
          if (protectedBullet.pinned || protectedBullet.origin === 'manual') {
            return { op: 'ignore', current: protectedBullet };
          }
        }
        const category = String(operation.category || '');
        const text = String(operation.text || '').trim();
        const confidence = String(operation.confidence || 'inferred');
        if (!CATEGORIES.has(category)) throw new Error(`Categoría inválida: ${category || '(vacía)'}.`);
        if (!text || text.length > MAX_TEXT_CHARS) throw new Error('Texto de bullet vacío o demasiado largo.');
        if (!CONFIDENCES.has(confidence)) throw new Error('Confianza inválida.');
        const sourceCaptionIds = validateSources(operation.sourceCaptionIds, pendingMap, category);
        if (operation.op === 'update') {
          const current = byId.get(String(operation.id || ''));
          if (!current) throw new Error('No existe el bullet que se intenta actualizar.');
          if (targetedIds.has(current.id)) throw new Error('Un bullet no puede recibir operaciones conflictivas.');
          targetedIds.add(current.id);
          return { op: 'update', current, category, text, confidence, sourceCaptionIds };
        }
        return { op: 'add', category, text, confidence, sourceCaptionIds };
      });
    }

    function sourceTimestamps(ids, allRows) {
      const map = new Map(allRows.map((row) => [Number(row.captionId), Number(row.t) || Date.now()]));
      return ids.map((id) => map.get(id)).filter(Number.isFinite);
    }

    function trimRecords() {
      const ledger = ensureLedger();
      const active = ledger.bullets.filter((bullet) => bullet.active);
      if (active.length > C.MEMORY_LEDGER_MAX_ACTIVE) {
        const removable = active
          .filter((bullet) => !bullet.pinned && bullet.origin !== 'manual')
          .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const bullet of removable.slice(0, active.length - C.MEMORY_LEDGER_MAX_ACTIVE)) {
          bullet.active = false;
          bullet.updatedAt = Date.now();
        }
      }
      if (ledger.bullets.length > C.MEMORY_LEDGER_MAX_RECORDS) {
        const tombstones = ledger.bullets
          .filter((bullet) => !bullet.active && !bullet.pinned)
          .sort((a, b) => a.updatedAt - b.updatedAt);
        const removeIds = new Set(tombstones
          .slice(0, ledger.bullets.length - C.MEMORY_LEDGER_MAX_RECORDS)
          .map((bullet) => bullet.id));
        ledger.bullets = ledger.bullets.filter((bullet) => !removeIds.has(bullet.id));
      }
    }

    function applyValidatedOperations(validated, rows, lastCaptionId) {
      const ledger = ensureLedger();
      const now = Date.now();
      const existingKeys = new Set(ledger.bullets.map((bullet) =>
        `${bullet.category}|${normalizeText(bullet.text)}|${[...bullet.sourceCaptionIds].sort((a, b) => a - b).join(',')}`
      ));
      const keyFor = (category, text, sourceIds) =>
        `${category}|${normalizeText(text)}|${[...sourceIds].sort((a, b) => a - b).join(',')}`;
      for (const operation of validated) {
        if (operation.current?.pinned || operation.current?.origin === 'manual') continue;
        if (operation.op === 'retire') {
          operation.current.active = false;
          operation.current.updatedAt = now;
          continue;
        }
        const timestamps = sourceTimestamps(operation.sourceCaptionIds, rows);
        if (operation.op === 'update') {
          existingKeys.delete(keyFor(
            operation.current.category, operation.current.text, operation.current.sourceCaptionIds
          ));
          const mergedSourceIds = [...new Set([
            ...operation.current.sourceCaptionIds, ...operation.sourceCaptionIds
          ])].slice(-MAX_SOURCE_IDS);
          const nextKey = keyFor(operation.category, operation.text, mergedSourceIds);
          if (existingKeys.has(nextKey)) {
            operation.current.active = false;
            operation.current.updatedAt = now;
            continue;
          }
          operation.current.category = operation.category;
          operation.current.text = operation.text;
          operation.current.confidence = operation.confidence;
          operation.current.sourceCaptionIds = mergedSourceIds;
          operation.current.sourceTimestamps = [...new Set([
            ...operation.current.sourceTimestamps, ...timestamps
          ])].slice(-MAX_SOURCE_IDS);
          operation.current.updatedAt = now;
          operation.current.active = true;
          existingKeys.add(nextKey);
          continue;
        }
        const dedupeKey = keyFor(operation.category, operation.text, operation.sourceCaptionIds);
        if (existingKeys.has(dedupeKey)) continue;
        existingKeys.add(dedupeKey);
        ledger.bullets.push({
          id: makeId(), category: operation.category, text: operation.text,
          sourceCaptionIds: operation.sourceCaptionIds, sourceTimestamps: timestamps,
          confidence: operation.confidence, origin: 'model', pinned: false, active: true,
          createdAt: now, updatedAt: now
        });
      }
      markRowsProcessed(ledger, rows, lastCaptionId);
      ledger.pendingSince = null;
      ledger.questionsSinceUpdate = 0;
      trimRecords();
    }

    async function requestUpdate() {
      if (getMode() !== 'automatic' || activeRequestId || !state.config?.apiKey || !state.meetingSessionId) {
        return false;
      }
      const rows = pendingRows();
      if (rows.length === 0) return false;
      const ledger = ensureLedger();
      const dueByQuestions = ledger.questionsSinceUpdate >= C.SESSION_MEMORY_UPDATE_QUESTIONS;
      const dueByTime = ledger.pendingSince && Date.now() - ledger.pendingSince >= C.SESSION_MEMORY_UPDATE_INTERVAL_MS;
      if (!dueByQuestions && !dueByTime) {
        notifyTranscriptChanged();
        return false;
      }
      if (state.isLoading || state.pendingAiRequest) {
        scheduleUpdate(C.MEMORY_UPDATE_DELAY_MS);
        return false;
      }

      const requestId = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeRequestId = requestId;
      setStatus('updating', 'Actualizando memoria…');
      const memoryModel = state.config.memoryModel || state.config.model;
      const memoryModelMetadata = state.config.memoryModel
        ? (state.config.memoryModelMetadata || null)
        : (state.config.modelMetadata || null);
      const lastCaptionId = Math.max(...rows.map((row) => Number(row.captionId)));
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'GET_MEMORY_LEDGER_UPDATE',
            requestId,
            data: {
              provider: state.config.provider || 'gemini',
              apiKey: state.config.apiKey,
              model: memoryModel,
              modelMetadata: memoryModelMetadata,
              meetingSessionId: state.meetingSessionId,
              openRouterRouting: state.config.openRouterRouting || 'latency',
              reasoningEffort: 'none',
              maxCompletionTokens: 1800,
              temperature: 0.1,
              systemPrompt: 'Eres un extractor factual. Responde únicamente JSON válido que cumpla el esquema solicitado.',
              messages: [{ role: 'user', content: buildUpdatePrompt(rows) }]
            }
          }, (result) => {
            if (chrome.runtime?.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
            else resolve(result || { success: false, error: 'Respuesta vacía del background.' });
          });
        });
        if (activeRequestId !== requestId) return false;
        if (!response?.success) throw new Error(response?.error || 'No se pudo actualizar la memoria.');
        const operations = parseOperations(response.suggestion);
        const validated = validateOperations(operations, rows);
        applyValidatedOperations(validated, rows, lastCaptionId);
        modules.sessionLog.recordApiUsage(response.usage, 'memory-ledger');
        await persistNow();
        setStatus('idle', `Memoria actualizada · ${activeBullets().length} bullets`);
        notifyTranscriptChanged();
        return true;
      } catch (err) {
        if (activeRequestId === requestId) {
          modules.sessionLog.recordIaError(`No se pudo actualizar el ledger: ${err.message}`);
          setStatus('error', `Memoria pendiente: ${err.message}`);
          scheduleUpdate(C.SESSION_MEMORY_UPDATE_RETRY_MS);
        }
        return false;
      } finally {
        if (activeRequestId === requestId) activeRequestId = null;
      }
    }

    function activeBullets() {
      return ensureLedger().bullets.filter((bullet) => bullet.active);
    }

    function editBullet(id, text) {
      const bullet = ensureLedger().bullets.find((item) => item.id === id && item.active);
      const clean = String(text || '').trim();
      if (!bullet || !clean || clean.length > MAX_TEXT_CHARS) return false;
      bullet.text = clean;
      bullet.confidence = 'confirmed';
      bullet.origin = 'manual';
      bullet.pinned = true;
      bullet.updatedAt = Date.now();
      schedulePersist();
      render();
      return true;
    }

    function togglePin(id) {
      const bullet = ensureLedger().bullets.find((item) => item.id === id && item.active);
      if (!bullet) return false;
      bullet.pinned = !bullet.pinned;
      bullet.updatedAt = Date.now();
      schedulePersist();
      render();
      return true;
    }

    function retireBullet(id) {
      const bullet = ensureLedger().bullets.find((item) => item.id === id && item.active);
      if (!bullet) return false;
      bullet.active = false;
      bullet.updatedAt = Date.now();
      schedulePersist();
      render();
      return true;
    }

    function bulletLine(bullet) {
      const flags = [bullet.confidence, bullet.origin];
      if (bullet.pinned) flags.push('fijado');
      return `- [${flags.join(' · ')}] ${bullet.text}`;
    }

    function buildLedgerBlock(queryText) {
      const terms = tokenize(queryText);
      const active = activeBullets();
      const selected = [];
      const seen = new Set();
      const add = (items) => {
        for (const bullet of items) {
          if (seen.has(bullet.id)) continue;
          seen.add(bullet.id);
          selected.push(bullet);
        }
      };
      add(active.filter((bullet) => bullet.pinned || bullet.confidence === 'confirmed')
        .map((bullet) => ({ bullet, score: lexicalScore(bullet.text, terms) }))
        .sort((a, b) => Number(b.bullet.pinned) - Number(a.bullet.pinned) || b.score - a.score || b.bullet.updatedAt - a.bullet.updatedAt)
        .map((item) => item.bullet));
      add(active.filter((bullet) => ['story-used', 'commitment', 'pending'].includes(bullet.category))
        .map((bullet) => ({ bullet, score: lexicalScore(bullet.text, terms) }))
        .filter((item) => item.score > 0 || terms.size === 0)
        .sort((a, b) => b.score - a.score || b.bullet.updatedAt - a.bullet.updatedAt)
        .map((item) => item.bullet));
      add(active.map((bullet) => ({ bullet, score: lexicalScore(bullet.text, terms) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || b.bullet.updatedAt - a.bullet.updatedAt)
        .map((item) => item.bullet));
      let output = '';
      for (const bullet of selected) {
        const line = `[${CATEGORY_LABELS[bullet.category]}] ${bulletLine(bullet)}\n`;
        if (output.length + line.length > C.MEMORY_LEDGER_PROMPT_MAX_CHARS) break;
        output += line;
      }
      return output.trim();
    }

    function buildContext(queryText = '') {
      const sections = [];
      const ledgerBlock = getMode() === 'off' ? '' : buildLedgerBlock(queryText);
      if (ledgerBlock) sections.push(`MEMORIA VERIFICABLE DE LA ENTREVISTA:\n${ledgerBlock}`);
      const transcriptContext = modules.sessionLog.buildTranscriptContextForPrompt(queryText);
      if (transcriptContext) sections.push(transcriptContext);
      return sections.join('\n\n').slice(0, C.SESSION_DIGEST_MAX_CHARS);
    }

    function getViewState() {
      return {
        bullets: activeBullets().map((bullet) => ({ ...bullet })),
        count: activeBullets().length,
        status: state.memoryLedgerStatus || { status: 'idle', text: 'Memoria lista' },
        mode: getMode(),
        categoryLabels: { ...CATEGORY_LABELS }
      };
    }

    function formatMarkdown() {
      const lines = [
        '# Memoria de entrevista', '',
        `- Sesión: ${state.meetingSessionId || '(sin id)'}`,
        `- Generado: ${new Date().toISOString()}`, ''
      ];
      for (const category of Object.keys(CATEGORY_LABELS)) {
        const bullets = activeBullets().filter((bullet) => bullet.category === category);
        if (!bullets.length) continue;
        lines.push(`## ${CATEGORY_LABELS[category]}`, '');
        for (const bullet of bullets) {
          const sources = bullet.sourceCaptionIds.length ? ` · captions ${bullet.sourceCaptionIds.join(', ')}` : '';
          lines.push(`${bulletLine(bullet)}${sources}`);
        }
        lines.push('');
      }
      return lines.join('\n').trim() + '\n';
    }

    function exportData(format = 'json') {
      const isMarkdown = format === 'md' || format === 'markdown';
      const body = isMarkdown
        ? formatMarkdown()
        : JSON.stringify({ ...ensureLedger(), exportedAt: Date.now() }, null, 2);
      const extension = isMarkdown ? 'md' : 'json';
      const mime = isMarkdown ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8';
      const blob = new Blob([body], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ia-memory-${state.meetingSessionId || 'session'}-${Date.now()}.${extension}`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return body;
    }

    return {
      CATEGORY_LABELS,
      restoreAndMigrate,
      resetForSession,
      notifyTranscriptChanged,
      noteResponseCompleted,
      requestUpdate,
      cancelUpdate,
      setMode,
      applyConfiguredMode,
      parseOperations,
      validateOperations,
      applyValidatedOperations,
      buildContext,
      editBullet,
      togglePin,
      retireBullet,
      getViewState,
      formatMarkdown,
      exportData,
      persistNow
    };
  };
})();
