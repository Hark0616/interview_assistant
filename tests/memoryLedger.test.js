/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('memoryLedger.js', () => {
  let state;
  let C;
  let modules;
  let ledger;
  let storage;
  let sendMessageImpl;

  beforeEach(() => {
    vi.useFakeTimers();
    window.__ia = {};
    storage = {};
    sendMessageImpl = (_payload, callback) => callback?.({ success: false, error: 'sin mock' });
    global.chrome = {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((payload, callback) => sendMessageImpl(payload, callback))
      },
      storage: {
        local: {
          get: vi.fn((keys, callback) => {
            const result = {};
            for (const key of keys) if (storage[key] != null) result[key] = storage[key];
            callback(result);
          }),
          set: vi.fn((value, callback) => {
            Object.assign(storage, structuredClone(value));
            callback?.();
          })
        }
      }
    };
    state = {
      meetingSessionId: 'session-a',
      sessionTranscript: [],
      sessionAiEvents: [],
      config: {
        provider: 'openrouter', apiKey: 'key', model: 'main/model', modelMetadata: { contextLength: 100000 }
      },
      isLoading: false,
      pendingAiRequest: false,
      memoryLedger: null
    };
    C = {
      STORAGE_KEY_MEMORY_LEDGER_PREFIX: 'iaInterviewMemoryLedger:',
      SESSION_PERSIST_DEBOUNCE_MS: 0,
      SESSION_MEMORY_UPDATE_INTERVAL_MS: 10 * 60 * 1000,
      SESSION_MEMORY_UPDATE_QUESTIONS: 5,
      SESSION_MEMORY_UPDATE_RETRY_MS: 60 * 1000,
      MEMORY_UPDATE_DELAY_MS: 2000,
      MEMORY_UPDATE_MAX_TRANSCRIPT_CHARS: 40000,
      MEMORY_LEDGER_MAX_ACTIVE: 250,
      MEMORY_LEDGER_MAX_RECORDS: 500,
      MEMORY_LEDGER_PROMPT_MAX_CHARS: 12000,
      SESSION_DIGEST_MAX_CHARS: 36000
    };
    modules = {
      ui: { renderMemory: vi.fn() },
      sessionLog: {
        buildTranscriptContextForPrompt: vi.fn(() => 'VENTANA RECIENTE LITERAL:\ntexto'),
        recordApiUsage: vi.fn(),
        recordIaError: vi.fn()
      }
    };
    const code = fs.readFileSync(path.resolve(__dirname, '../memoryLedger.js'), 'utf8');
    eval(code);
    ledger = window.__ia.createMemoryLedger(state, C, modules);
  });

  afterEach(() => {
    ledger.cancelUpdate('fin de prueba');
    vi.useRealTimers();
  });

  function caption(id, role, text = `caption ${id}`) {
    return { captionId: id, role, text, speaker: role === 'me' ? 'Yo' : 'Entrevistador', t: 1000 + id };
  }

  function opAdd(overrides = {}) {
    return {
      op: 'add', category: 'candidate-fact', text: 'Implementé OAuth en producción',
      sourceCaptionIds: [1], confidence: 'confirmed', ...overrides
    };
  }

  it('migra memoria textual 1.6.0 sin mezclarla con el log y la persiste por sesión', async () => {
    await ledger.restoreAndMigrate({
      memory: 'TECNOLOGÍAS, MÉTRICAS Y EXPERIENCIAS MENCIONADAS\n- PLC Siemens S7',
      memoryProcessedCaptionId: 9,
      memoryUpdatedAt: 1234
    });

    const view = ledger.getViewState();
    expect(view.bullets).toHaveLength(1);
    expect(view.bullets[0]).toMatchObject({
      category: 'technology-metric', text: 'PLC Siemens S7', origin: 'legacy', confidence: 'inferred'
    });
    expect(storage['iaInterviewMemoryLedger:session-a'].processedCaptionId).toBe(9);
    expect(storage).not.toHaveProperty('iaMeetingSessionLog');
  });

  it('restaura ledgers aislados por meetingSessionId', async () => {
    storage['iaInterviewMemoryLedger:session-a'] = {
      meetingSessionId: 'session-a', bullets: [{
        id: 'a', category: 'style', text: 'Español', sourceCaptionIds: [1], sourceTimestamps: [1],
        confidence: 'confirmed', origin: 'model', pinned: false, active: true, createdAt: 1, updatedAt: 1
      }]
    };
    storage['iaInterviewMemoryLedger:session-b'] = {
      meetingSessionId: 'session-b', bullets: [{
        id: 'b', category: 'style', text: 'English', sourceCaptionIds: [2], sourceTimestamps: [2],
        confidence: 'confirmed', origin: 'model', pinned: false, active: true, createdAt: 2, updatedAt: 2
      }]
    };

    await ledger.restoreAndMigrate();
    expect(ledger.getViewState().bullets[0].id).toBe('a');
    state.meetingSessionId = 'session-b';
    await ledger.restoreAndMigrate();
    expect(ledger.getViewState().bullets[0].id).toBe('b');
  });

  it('valida fuentes/categorías/IDs y aplica un lote válido de forma atómica', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me'), caption(2, 'interviewer')];
    const rows = [...state.sessionTranscript];
    const valid = ledger.validateOperations([
      opAdd(),
      opAdd({ category: 'interviewer-context', text: 'Busca experiencia backend', sourceCaptionIds: [2] })
    ], rows);
    ledger.applyValidatedOperations(valid, rows, 2);
    expect(ledger.getViewState().bullets).toHaveLength(2);
    expect(state.memoryLedger.processedCaptionId).toBe(2);

    expect(() => ledger.validateOperations([
      opAdd({ category: 'invalid' })
    ], rows)).toThrow(/Categoría inválida/);
    expect(() => ledger.validateOperations([
      { op: 'update', id: 'missing', category: 'style', text: 'Directo', sourceCaptionIds: [1], confidence: 'inferred' }
    ], rows)).toThrow(/No existe/);
    expect(() => ledger.validateOperations([
      opAdd({ category: 'technology-metric', sourceCaptionIds: [2] })
    ], rows)).toThrow(/candidato/);
  });

  it('protege bullets editados manualmente contra update y retire del modelo', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me'), caption(2, 'me')];
    let valid = ledger.validateOperations([opAdd()], [state.sessionTranscript[0]]);
    ledger.applyValidatedOperations(valid, [state.sessionTranscript[0]], 1);
    const id = ledger.getViewState().bullets[0].id;
    expect(ledger.editBullet(id, 'Texto confirmado por mí')).toBe(true);

    valid = ledger.validateOperations([
      { op: 'update', id, category: 'candidate-fact', text: 'Texto del modelo', sourceCaptionIds: [2], confidence: 'confirmed' },
      { op: 'retire', id, sourceCaptionIds: [2] }
    ], [state.sessionTranscript[1]]);
    ledger.applyValidatedOperations(valid, [state.sessionTranscript[1]], 2);
    expect(ledger.getViewState().bullets[0]).toMatchObject({
      text: 'Texto confirmado por mí', confidence: 'confirmed', origin: 'manual', pinned: true, active: true
    });
  });

  it('procesa solo captions, usa el modelo principal como fallback y registra telemetría memory-ledger', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me', 'Trabajé con Node.js')];
    state.sessionAiEvents = [{ kind: 'response', text: 'SUGERENCIA INVENTADA' }];
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    let sentPayload;
    sendMessageImpl = (payload, callback) => {
      sentPayload = payload;
      callback({
        success: true,
        suggestion: JSON.stringify({ operations: [opAdd({ text: 'Trabajé con Node.js' })] }),
        usage: { promptTokens: 100, completionTokens: 20, cost: 0.001 }
      });
    };

    expect(await ledger.requestUpdate()).toBe(true);
    expect(sentPayload.type).toBe('GET_MEMORY_LEDGER_UPDATE');
    expect(sentPayload.data.model).toBe('main/model');
    expect(sentPayload.data.modelMetadata).toEqual({ contextLength: 100000 });
    expect(sentPayload.data.messages[0].content).toContain('Trabajé con Node.js');
    expect(sentPayload.data.messages[0].content).not.toContain('SUGERENCIA INVENTADA');
    expect(modules.sessionLog.recordApiUsage).toHaveBeenCalledWith(expect.anything(), 'memory-ledger');
  });

  it('reprocesa una revisión nueva del mismo caption ya procesado', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me', 'Implementé OAuth')];
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    sendMessageImpl = (_payload, callback) => callback({
      success: true,
      suggestion: JSON.stringify({ operations: [opAdd({ text: 'Implementé OAuth' })] })
    });

    expect(await ledger.requestUpdate()).toBe(true);
    expect(state.memoryLedger.processedCaptionRevisions['1']).toBe(1);

    const bulletId = ledger.getViewState().bullets[0].id;
    state.sessionTranscript[0].text = 'Implementé OAuth con rotación de JWT';
    state.sessionTranscript[0].revision = 2;
    ledger.notifyTranscriptChanged();
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();

    let updatePrompt = '';
    sendMessageImpl = (payload, callback) => {
      updatePrompt = payload.data.messages[0].content;
      callback({
        success: true,
        suggestion: JSON.stringify({ operations: [
          opAdd({
            op: 'update', id: bulletId, text: 'Implementé OAuth con rotación de JWT', sourceCaptionIds: [1]
          })
        ] })
      });
    };

    expect(await ledger.requestUpdate()).toBe(true);
    expect(updatePrompt).toContain('Implementé OAuth con rotación de JWT');
    expect(state.memoryLedger.processedCaptionRevisions['1']).toBe(2);
    expect(ledger.getViewState().bullets[0].text).toBe('Implementé OAuth con rotación de JWT');
  });

  it('usa el modelo de memoria configurado con su propia metadata', async () => {
    await ledger.resetForSession();
    state.config.memoryModel = 'fast/memory-model';
    state.config.memoryModelMetadata = { contextLength: 32000 };
    state.sessionTranscript = [caption(1, 'me')];
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    let data;
    sendMessageImpl = (payload, callback) => {
      data = payload.data;
      callback({ success: true, suggestion: JSON.stringify({ operations: [] }) });
    };

    expect(await ledger.requestUpdate()).toBe(true);
    expect(data.model).toBe('fast/memory-model');
    expect(data.modelMetadata).toEqual({ contextLength: 32000 });
    expect(data.apiKey).toBe('key');
    expect(data.provider).toBe('openrouter');
  });

  it('permite apagar el ledger o usarlo en solo lectura sin llamadas adicionales', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me')];
    const valid = ledger.validateOperations([opAdd()], state.sessionTranscript);
    ledger.applyValidatedOperations(valid, state.sessionTranscript, 1);

    ledger.setMode('off');
    expect(ledger.buildContext('OAuth')).not.toContain('MEMORIA VERIFICABLE');
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    expect(await ledger.requestUpdate()).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_MEMORY_LEDGER_UPDATE' }), expect.anything()
    );

    ledger.setMode('existing');
    expect(ledger.buildContext('OAuth')).toContain('Implementé OAuth en producción');
    expect(await ledger.requestUpdate()).toBe(false);
  });

  it('omite captions acumulados mientras está apagada al volver a automática', async () => {
    await ledger.resetForSession();
    ledger.setMode('off');
    state.sessionTranscript = [caption(10, 'interviewer', 'Pregunta durante entrevista corta')];
    ledger.notifyTranscriptChanged();
    expect(state.memoryLedger.processedCaptionId).toBe(10);

    ledger.setMode('automatic');
    state.sessionTranscript.push(caption(11, 'me', 'Respuesta después de activar memoria'));
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    let prompt;
    sendMessageImpl = (payload, callback) => {
      if (payload.type === 'GET_MEMORY_LEDGER_UPDATE') {
        prompt = payload.data.messages[0].content;
        callback({ success: true, suggestion: JSON.stringify({ operations: [] }) });
      }
    };

    expect(await ledger.requestUpdate()).toBe(true);
    expect(prompt).toContain('Respuesta después de activar memoria');
    expect(prompt).not.toContain('Pregunta durante entrevista corta');
  });

  it('no avanza el cursor con JSON inválido', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me')];
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    sendMessageImpl = (_payload, callback) => callback({ success: true, suggestion: 'no es json' });
    expect(await ledger.requestUpdate()).toBe(false);
    expect(state.memoryLedger.processedCaptionId).toBeNull();
  });

  it('cancela sin avanzar el cursor y permite reintentar los mismos captions', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me')];
    for (let i = 0; i < 5; i++) ledger.noteResponseCompleted();
    let delayedCallback;
    sendMessageImpl = (_payload, callback) => { delayedCallback = callback; };
    expect(state.memoryLedger.questionsSinceUpdate).toBe(5);
    const sendCount = chrome.runtime.sendMessage.mock.calls.length;
    const pending = ledger.requestUpdate();
    expect(chrome.runtime.sendMessage.mock.calls.length).toBe(sendCount + 1);
    expect(chrome.runtime.sendMessage.mock.calls.at(-1)[0].type).toBe('GET_MEMORY_LEDGER_UPDATE');
    expect(typeof chrome.runtime.sendMessage.mock.calls.at(-1)[1]).toBe('function');
    expect(typeof delayedCallback).toBe('function');
    const finishMemoryRequest = delayedCallback;
    ledger.cancelUpdate('principal');
    finishMemoryRequest({ success: true, suggestion: JSON.stringify({ operations: [opAdd()] }) });
    expect(await pending).toBe(false);
    expect(state.memoryLedger.processedCaptionId).toBeNull();

    sendMessageImpl = (_payload, callback) => callback({
      success: true, suggestion: JSON.stringify({ operations: [opAdd()] })
    });
    expect(await ledger.requestUpdate()).toBe(true);
    expect(state.memoryLedger.processedCaptionId).toBe(1);
  });

  it('prioriza bullets relevantes y respeta el presupuesto del bloque de ledger', async () => {
    await ledger.resetForSession();
    const now = Date.now();
    state.memoryLedger.bullets = Array.from({ length: 250 }, (_, index) => ({
      id: `b-${index}`,
      category: index === 249 ? 'story-used' : 'candidate-fact',
      text: index === 249 ? 'Migración crítica de OAuth y tokens JWT' : `Experiencia genérica ${index} ${'x'.repeat(100)}`,
      sourceCaptionIds: [index + 1], sourceTimestamps: [now], confidence: 'confirmed',
      origin: 'model', pinned: index === 0, active: true, createdAt: now, updatedAt: now + index
    }));

    const context = ledger.buildContext('¿Cómo migraste OAuth con JWT?');
    const ledgerBlock = context.split('\n\nVENTANA RECIENTE')[0];
    expect(ledgerBlock).toContain('Migración crítica de OAuth y tokens JWT');
    expect(ledgerBlock.length).toBeLessThanOrEqual(C.MEMORY_LEDGER_PROMPT_MAX_CHARS + 100);
    expect(context).toContain('VENTANA RECIENTE LITERAL');
  });

  it('genera Markdown legible con confianza, origen y fuentes', async () => {
    await ledger.resetForSession();
    state.sessionTranscript = [caption(1, 'me')];
    const valid = ledger.validateOperations([opAdd()], state.sessionTranscript);
    ledger.applyValidatedOperations(valid, state.sessionTranscript, 1);
    const markdown = ledger.formatMarkdown();
    expect(markdown).toContain('# Memoria de entrevista');
    expect(markdown).toContain('## Hechos del candidato');
    expect(markdown).toContain('confirmed · model');
    expect(markdown).toContain('captions 1');
  });
});
