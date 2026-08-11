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
