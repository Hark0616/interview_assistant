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
        addListener: vi.fn()
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
      isLoading: false
    };
    C = {
      AI_CONTEXT_MAX_LINES: 10,
      AI_CONTEXT_MAX_CHARS: 1000,
      AI_REQUEST_COOLDOWN_MS: 0
    };
    modules = {
      sessionLog: {
        findLastUserSpokeIndex: vi.fn(() => -1),
        buildSessionDigestForPrompt: vi.fn(() => ''),
        recordIaActivation: vi.fn(),
        recordIaResponse: vi.fn(),
        recordIaError: vi.fn()
      },
      ui: {
        updateStatus: vi.fn(),
        setLoadingState: vi.fn(),
        displaySuggestion: vi.fn()
      }
    };

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

  it('no debería solicitar sugerencia si no hay API Key', async () => {
    state.config.apiKey = '';
    await aiClient.requestSuggestion();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
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
  });
});
