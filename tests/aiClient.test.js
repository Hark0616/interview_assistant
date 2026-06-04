import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('aiClient.js', () => {
  let state, C, modules, aiClient;

  beforeEach(() => {
    // Mocks globales
    global.window = global;
    global.window.__ia = {};
    global.chrome = {
      runtime: {
        sendMessage: vi.fn(),
        lastError: null
      }
    };

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
        recordIaResponse: vi.fn()
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
    
    // Simular respuesta exitosa del background script
    chrome.runtime.sendMessage.mockImplementation((payload, callback) => {
      callback({ success: true, suggestion: 'Estoy bien' });
    });

    await aiClient.requestSuggestion();

    expect(modules.ui.displaySuggestion).toHaveBeenCalledWith('Estoy bien');
    expect(state.suggestionHistory[0].answer).toBe('Estoy bien');
  });
});
