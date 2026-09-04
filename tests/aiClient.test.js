import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('aiClient.js', () => {
  let state, C, modules, aiClient;

  beforeEach(() => {
    // Mocks globales
    global.window = global;
    global.window.__ia = {};
    
    const mockPort = {
      postMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn((listener) => {
          mockPort._messageListener = listener;
        })
      },
      onDisconnect: {
        addListener: vi.fn((listener) => {
          mockPort._disconnectListener = listener;
        })
      },
      disconnect: vi.fn()
    };

    global.chrome = {
      runtime: {
        sendMessage: vi.fn(),
        connect: vi.fn(() => mockPort),
        lastError: null
      }
    };

    global.mockPort = mockPort;

    // Estado inicial de prueba
    state = {
      config: { myName: 'TestUser', apiKey: '123', provider: 'gemini' },
      captionBuffer: [],
      suggestionHistory: [],
      isLoading: false,
      pendingAiRequest: false,
      pendingAiTimer: null,
      currentAiPort: null,
      lastAiRequestCompletedAt: 0
    };
    C = {
      AI_CONTEXT_MAX_LINES: 10,
      AI_CONTEXT_MAX_CHARS: 1000,
      AI_REQUEST_COOLDOWN_MS: 0
    };
    modules = {
      sessionLog: {
        findLastUserSpokeIndex: vi.fn(() => -1),
        recordIaActivation: vi.fn(),
        recordIaResponse: vi.fn(),
        recordApiUsage: vi.fn(),
        recordIaError: vi.fn()
      },
      memoryLedger: {
        buildContext: vi.fn(() => ''),
        cancelUpdate: vi.fn(),
        noteResponseCompleted: vi.fn()
      },
      ui: {
        updateStatus: vi.fn(),
        setLoadingState: vi.fn(),
        displaySuggestion: vi.fn(),
        setUserNote: vi.fn()
      }
    };

    const utilsCode = fs.readFileSync(path.resolve(__dirname, '../utils.js'), 'utf8');
    eval(utilsCode);
    const code = fs.readFileSync(path.resolve(__dirname, '../aiClient.js'), 'utf8');
    eval(code);
    aiClient = window.__ia.createAiClient(state, C, modules);
  });

  it('debería construir el system prompt correctamente', () => {
    state.config.jobDescription = 'Senior Dev';
    const prompt = aiClient.buildSystemPrompt();
    expect(prompt).toContain('Senior Dev');
    expect(prompt).toContain('TestUser');
  });

  it('debería iniciar en español y no depender del idioma predominante', () => {
    const prompt = aiClient.buildSystemPrompt();

    expect(prompt.startsWith('IDIOMA OBLIGATORIO DE RESPUESTA')).toBe(true);
    expect(prompt).toContain('Responde siempre en español');
    expect(prompt).not.toContain('idioma predominante de la pregunta más reciente');
  });

  it('debería forzar inglés aunque el contexto esté en español', () => {
    state.config.responseLanguage = 'en';
    state.config.cvProfile = 'Experiencia profesional en español con proyectos de backend.';
    state.config.jobDescription = 'Liderar un equipo de plataforma.';

    const prompt = aiClient.buildSystemPrompt();

    expect(prompt.startsWith('IDIOMA OBLIGATORIO DE RESPUESTA')).toBe(true);
    expect(prompt).toContain('Responde siempre en inglés');
    expect(prompt).not.toContain('Responde siempre en español');
  });

  it('debería mantener español aunque la pregunta esté en inglés', () => {
    state.config.responseLanguage = 'es';
    state.captionBuffer = [{
      id: 1,
      role: 'interviewer',
      text: 'Tell me about a difficult technical decision you made.'
    }];

    const prompt = aiClient.buildSystemPrompt();

    expect(prompt).toContain('Responde siempre en español');
    expect(prompt).not.toContain('Responde siempre en inglés');
  });

  it('no debería aceptar idiomas no soportados ni activar un modo automático', () => {
    state.config.responseLanguage = 'fr';

    const prompt = aiClient.buildSystemPrompt();

    expect(prompt).toContain('Responde siempre en español');
    expect(prompt).not.toContain('francés');
    expect(prompt).not.toContain('idioma predominante');
  });

  it('no debería solicitar sugerencia si no hay API Key', async () => {
    state.config.apiKey = '';
    await aiClient.requestSuggestion();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('conserva un speaker desconocido en el contexto sin presentarlo como entrevistador', async () => {
    state.captionBuffer = [{
      id: 1, role: 'unknown', text: 'Could you walk me through your approach?'
    }];

    await aiClient.requestSuggestion({ force: true });
    const sent = global.mockPort.postMessage.mock.calls[0][0];

    expect(sent.data.messages[0].content).toContain('[ORADOR NO IDENTIFICADO]');
    expect(sent.data.messages[0].content).not.toContain('[ENTREVISTADOR]: Could you');
  });

  it('debería manejar una respuesta exitosa de la IA', async () => {
    state.captionBuffer = [{ id: 1, role: 'interviewer', text: '¿Como estas?' }];
    
    const requestPromise = aiClient.requestSuggestion();

    expect(chrome.runtime.connect).toHaveBeenCalled();
    const port = global.mockPort;
    
    if (port._messageListener) {
      port._messageListener({ type: 'chunk', text: 'Estoy bien' });
      port._messageListener({ type: 'done' });
    }

    await requestPromise;

    expect(modules.ui.displaySuggestion).toHaveBeenCalledWith('Estoy bien');
    expect(state.suggestionHistory[0].answer).toBe('Estoy bien');
    expect(modules.memoryLedger.noteResponseCompleted).toHaveBeenCalledOnce();
  });

  it('no debería volver a enviar automáticamente el mismo contexto sin cambios', async () => {
    state.captionBuffer = [{ id: 1, revision: 1, role: 'interviewer', text: '¿Cómo estás?' }];
    await aiClient.requestSuggestion();
    global.mockPort._messageListener({ type: 'chunk', text: 'Estoy bien' });
    global.mockPort._messageListener({ type: 'done' });

    await aiClient.requestSuggestion();

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(1);
    expect(modules.ui.displaySuggestion).toHaveBeenCalledWith(
      expect.stringContaining('No hay subtítulos nuevos'),
      true
    );
  });

  it('debería permitir Regenerar aunque no haya captions nuevos', async () => {
    state.captionBuffer = [{ id: 1, revision: 1, role: 'interviewer', text: '¿Cómo estás?' }];
    await aiClient.requestSuggestion();
    global.mockPort._messageListener({ type: 'chunk', text: 'Primera respuesta' });
    global.mockPort._messageListener({ type: 'done' });

    await aiClient.requestSuggestion({ force: true });

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
    expect(global.mockPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'GET_AI_SUGGESTION_STREAM' })
    );
  });

  it('debería reenviar una revisión nueva del mismo caption aunque conserve su ID', async () => {
    state.captionBuffer = [{ id: 1, revision: 1, role: 'interviewer', text: '¿Cómo trabajas con?' }];
    await aiClient.requestSuggestion();
    global.mockPort._messageListener({ type: 'chunk', text: 'Respuesta parcial' });
    global.mockPort._messageListener({ type: 'done' });

    state.captionBuffer[0].text = '¿Cómo trabajas con Kubernetes?';
    state.captionBuffer[0].revision = 2;
    await aiClient.requestSuggestion();

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
    expect(global.mockPort.postMessage.mock.calls.at(-1)[0].data.messages[0].content)
      .toContain('¿Cómo trabajas con Kubernetes?');
  });

  it('debería poner en cola el contexto que llega durante una respuesta', async () => {
    state.captionBuffer = [{ id: 1, role: 'interviewer', text: 'Primera pregunta' }];
    await aiClient.requestSuggestion();

    state.captionBuffer.push({ id: 2, role: 'interviewer', text: 'Segunda pregunta' });
    await aiClient.requestSuggestion();
    expect(state.pendingAiRequest).toBe(true);

    global.mockPort._messageListener({ type: 'chunk', text: 'Primera respuesta' });
    global.mockPort._messageListener({ type: 'done' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
    expect(state.lastAiContextCaptionId).toBe(1);
  });

  it('debería cancelar el puerto y limpiar la cola', async () => {
    state.captionBuffer = [{ id: 1, role: 'interviewer', text: 'Una pregunta' }];
    await aiClient.requestSuggestion();
    state.pendingAiRequest = true;

    aiClient.cancelCurrentRequest();

    expect(global.mockPort.postMessage).toHaveBeenCalledWith({ type: 'CANCEL_AI_SUGGESTION_STREAM' });
    expect(global.mockPort.disconnect).toHaveBeenCalled();
    expect(state.isLoading).toBe(false);
    expect(state.pendingAiRequest).toBe(false);
    expect(state.currentAiPort).toBeNull();
  });
});
