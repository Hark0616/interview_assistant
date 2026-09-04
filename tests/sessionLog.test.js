/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('sessionLog.js', () => {
  let state;
  let C;
  let modules;
  let sessionLog;
  let storedPayload;

  beforeEach(() => {
    window.__ia = {};
    storedPayload = null;
    global.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          set: vi.fn((value, callback) => {
            storedPayload = value;
            callback?.();
          }),
          get: vi.fn((_keys, callback) => callback(storedPayload || {}))
        }
      }
    };

    state = {
      meetingSessionId: '',
      sessionTranscript: [],
      sessionAiEvents: [],
      captionBuffer: [],
      nextCaptionLineId: 1,
      lastUserSpokeId: null,
      lastAiContextCaptionId: null,
      persistSessionTimer: null,
      sessionUsage: null
    };
    C = {
      SESSION_TRANSCRIPT_MAX_LINES: 4000,
      SESSION_AI_EVENTS_MAX: 80,
      SESSION_RECENT_MAX_LINES: 5,
      SESSION_RECENT_MAX_CHARS: 2000,
      SESSION_DIGEST_MAX_CHARS: 5000,
      SESSION_PERSIST_DEBOUNCE_MS: 0,
      SESSION_RESTORE_MAX_AGE_MS: 6 * 60 * 60 * 1000,
      SESSION_PROMPT_STORE_MAX: 60000,
      CAPTION_BUFFER_MAX: 500,
      STORAGE_KEY_MEETING_LOG: 'iaMeetingSessionLog'
    };
    modules = {
      ui: { updateUsage: vi.fn() },
      memoryLedger: { notifyTranscriptChanged: vi.fn(), formatMarkdown: vi.fn(() => '') }
    };

    const code = fs.readFileSync(path.resolve(__dirname, '../sessionLog.js'), 'utf8');
    eval(code);
    sessionLog = window.__ia.createSessionLog(state, C, modules);
  });

  it('conserva una sesión existente al reactivar', () => {
    state.meetingSessionId = 'meet-existing';
    state.sessionTranscript.push({ captionId: 1, text: 'contenido anterior' });

    expect(sessionLog.ensureSessionLog()).toBe(false);
    expect(state.meetingSessionId).toBe('meet-existing');
    expect(state.sessionTranscript).toHaveLength(1);
  });

  it('actualiza por captionId y conserva la revisión sin tocar otra línea del mismo speaker', () => {
    state.meetingSessionId = 'meet-existing';
    sessionLog.pushSessionTranscriptLine('Ivan', 'interviewer', 'Pregunta parcial', 1, 1);
    sessionLog.pushSessionTranscriptLine('Ivan', 'interviewer', 'Otra pregunta', 2, 1);

    sessionLog.syncSessionTranscriptLast('Ivan', 'interviewer', 'Pregunta completa', 1, 2);

    expect(state.sessionTranscript).toHaveLength(2);
    expect(state.sessionTranscript[0]).toMatchObject({
      captionId: 1, text: 'Pregunta completa', revision: 2
    });
    expect(state.sessionTranscript[1]).toMatchObject({
      captionId: 2, text: 'Otra pregunta', revision: 1
    });
  });

  it('combina una ventana literal reciente con fragmentos relevantes sin sugerencias IA', () => {
    state.sessionTranscript = Array.from({ length: 10 }, (_, index) => ({
      t: Date.now(),
      captionId: index + 1,
      role: index === 9 ? 'me' : 'interviewer',
      speaker: 'Persona',
      text: index === 1 ? 'implementé autenticación OAuth para la API' : `línea ${index + 1}`
    }));
    state.captionBuffer = state.sessionTranscript.map((row) => ({
      id: row.captionId,
      role: row.role,
      text: row.text
    }));
    state.lastUserSpokeId = 10;

    state.sessionAiEvents = [{ kind: 'response', text: 'Sugerencia que no debe ser memoria' }];
    const digest = sessionLog.buildTranscriptContextForPrompt('¿Cómo implementaste OAuth?');

    expect(digest).toContain('línea 10');
    expect(digest).toContain('FRAGMENTOS ANTERIORES RELEVANTES');
    expect(digest).toContain('autenticación OAuth');
    expect(digest).not.toContain('línea 1\n');
    expect(digest).not.toContain('Sugerencia que no debe ser memoria');
  });

  it('acumula tokens, caché, razonamiento y costo', () => {
    sessionLog.recordApiUsage({
      promptTokens: 100,
      completionTokens: 20,
      reasoningTokens: 5,
      cachedTokens: 60,
      cacheWriteTokens: 10,
      cost: 0.0123
    });

    expect(state.sessionUsage).toMatchObject({
      requests: 1,
      promptTokens: 100,
      completionTokens: 20,
      reasoningTokens: 5,
      cachedTokens: 60,
      cacheWriteTokens: 10,
      cost: 0.0123
    });
    expect(sessionLog.formatUsageSummary()).toContain('$0.0123');
    expect(modules.ui.updateUsage).toHaveBeenCalled();
  });

  it('cuenta respuestas exitosas aunque el proveedor no devuelva usage', () => {
    sessionLog.recordApiUsage(null, 'suggestion');

    expect(state.sessionUsage).toMatchObject({
      requests: 1,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0
    });
    expect(state.sessionAiEvents.at(-1)).toMatchObject({
      kind: 'usage', purpose: 'suggestion', usage: {}
    });
    expect(sessionLog.formatUsageSummary()).toContain('1 req');
  });

  it('exporta la transcripción consolidada con roles, revisiones, memoria y eventos IA', () => {
    state.meetingSessionId = 'meet-session';
    sessionLog.pushSessionTranscriptLine('Ivan', 'interviewer', 'Pregunta parcial', 11, 1);
    sessionLog.syncSessionTranscriptLast('Ivan', 'interviewer', 'Pregunta completa', 11, 2);
    sessionLog.pushSessionTranscriptLine('', 'unknown', 'No se pudo atribuir', 12, 1);
    sessionLog.recordIaActivation('Prompt enviado');
    sessionLog.recordIaResponse('Respuesta generada');
    sessionLog.recordApiUsage(null, 'suggestion');
    sessionLog.recordIaActivation('Prompt enviado');
    sessionLog.recordIaResponse('Respuesta generada');
    sessionLog.recordIaError('Error de prueba');
    modules.memoryLedger.formatMarkdown.mockReturnValue('## Hechos\n- Experiencia en APIs');

    const output = sessionLog.formatSessionLogForDownload();

    expect(output).toContain('Transcripción consolidada de la sesión');
    expect(output).toContain('[ENTREVISTADOR] Ivan [captionId 11 · rev 2]: Pregunta completa');
    expect(output).not.toContain('Pregunta parcial');
    expect(output).toContain('[ORADOR NO IDENTIFICADO] ? [captionId 12 · rev 1]: No se pudo atribuir');
    expect(output).toContain('## Hechos');
    expect(output.match(/Prompt enviado/g)).toHaveLength(1);
    expect(output.match(/Respuesta generada/g)).toHaveLength(1);
    expect(output).toContain('contexto repetido exactamente');
    expect(output).toContain('Sugerencia IA repetida exactamente');
    expect(output).toContain('USO suggestion: 0 in, 0 out, 0 cache, $0.000000');
    expect(output).toContain('ERROR: Error de prueba');
  });

  it('restaura más de 800 líneas y entrega la memoria 1.6.0 para migración', async () => {
    const transcript = Array.from({ length: 1000 }, (_, index) => ({
      t: Date.now(), captionId: index + 1, role: 'interviewer', text: `línea ${index}`
    }));
    storedPayload = {
      [C.STORAGE_KEY_MEETING_LOG]: {
        meetingCode: 'meet',
        meetingSessionId: 'restored-session',
        updatedAt: Date.now(),
        transcript,
        aiEvents: [],
        memory: 'memoria persistida',
        usage: { requests: 4, cost: 0.25 }
      }
    };

    const restored = await new Promise((resolve) => {
      sessionLog.restoreSessionLog((ok, legacy) => resolve({ ok, legacy }));
    });

    expect(restored.ok).toBe(true);
    expect(state.sessionTranscript).toHaveLength(1000);
    expect(restored.legacy.memory).toBe('memoria persistida');
    expect(state.sessionUsage.requests).toBe(4);
    expect(state.sessionWasRestored).toBe(true);
  });
});
