/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

function loadScript(file) {
  const code = fs.readFileSync(path.resolve(__dirname, `../${file}`), 'utf8');
  eval(code);
}

const memoryView = {
  count: 1,
  status: { status: 'idle', text: 'Memoria actualizada' },
  categoryLabels: { 'candidate-fact': 'Hechos del candidato' },
  bullets: [{
    id: 'bullet-1', category: 'candidate-fact', text: 'Experiencia con Node.js',
    confidence: 'confirmed', origin: 'model', pinned: false,
    sourceCaptionIds: [4], sourceTimestamps: [1004], active: true
  }]
};

describe('UI de memoria', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.__ia = {};
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sincroniza memoria del overlay al panel y permite editar/exportar', () => {
    global.chrome = {
      runtime: { sendMessage: vi.fn(() => Promise.resolve({ success: true })) },
      storage: { local: { get: vi.fn(), set: vi.fn() } }
    };
    loadScript('utils.js');
    loadScript('overlayUI.js');
    const state = {
      panelActive: true, isActive: false, isLoading: false, manualModeActive: false,
      config: { apiKey: 'key', myName: 'Yo', debounceMs: 2800 }, userNote: '',
      captionBuffer: [], memoryCollapsed: true, transcriptCollapsed: false,
      transcriptFollowLatest: true, overlay: null, sessionTranscript: [], sessionAiEvents: []
    };
    const memoryLedger = {
      getViewState: vi.fn(() => memoryView),
      editBullet: vi.fn(), togglePin: vi.fn(), retireBullet: vi.fn(), exportData: vi.fn(),
      resetForSession: vi.fn(), setMode: vi.fn()
    };
    const modules = {
      memoryLedger,
      sessionLog: {
        formatUsageSummary: vi.fn(() => '0 req'), ensureSessionLog: vi.fn(() => false),
        downloadSessionLogFile: vi.fn()
      },
      captionCapture: { startCaptionObserver: vi.fn(), stopCaptionObserver: vi.fn() },
      ai: { requestSuggestion: vi.fn(), cancelCurrentRequest: vi.fn() }
    };
    modules.ui = window.__ia.createOverlayUI(state, {}, modules);
    modules.ui.createOverlay();
    modules.ui.renderMemory();
    vi.advanceTimersByTime(100);

    const panelState = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'IA_PANEL_STATE');
    expect(panelState.data.memory.bullets[0].id).toBe('bullet-1');
    expect(document.getElementById('ia-memory-list').textContent).toContain('Experiencia con Node.js');

    vi.spyOn(window, 'prompt').mockReturnValue('Experiencia confirmada con Node.js');
    document.querySelector('#ia-memory-list [data-memory-action="edit"]').click();
    expect(memoryLedger.editBullet).toHaveBeenCalledWith('bullet-1', 'Experiencia confirmada con Node.js');
    document.getElementById('ia-memory-export-json').click();
    document.getElementById('ia-memory-export-md').click();
    expect(memoryLedger.exportData).toHaveBeenCalledWith('json');
    expect(memoryLedger.exportData).toHaveBeenCalledWith('md');
    const mode = document.getElementById('ia-memory-mode');
    mode.value = 'off';
    mode.dispatchEvent(new Event('change'));
    expect(memoryLedger.setMode).toHaveBeenCalledWith('off');
  });

  it('renderiza el ledger recibido en el panel y retransmite sus comandos', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../panel.html'), 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '');
    document.open();
    document.write(html);
    document.close();
    let messageListener;
    global.chrome = {
      runtime: {
        onMessage: { addListener: vi.fn((listener) => { messageListener = listener; }) },
        sendMessage: vi.fn(() => Promise.resolve())
      }
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: vi.fn(() => Promise.resolve()) }
    });
    loadScript('utils.js');
    loadScript('panel.js');

    messageListener({
      type: 'IA_PANEL_STATE',
      data: {
        statusState: 'active', statusText: 'Activo', usageText: '1 req',
        transcript: [], suggestion: { text: '' }, memory: memoryView,
        isLoading: false, isActive: true, manualMode: false, debounceMs: 2800, userNote: ''
      }
    });
    expect(document.getElementById('ia-panel-memory-list').textContent).toContain('Experiencia con Node.js');

    vi.spyOn(window, 'prompt').mockReturnValue('Editado desde panel');
    document.querySelector('#ia-panel-memory-list [data-memory-action="edit"]').click();
    document.getElementById('ia-panel-memory-md').click();
    const mode = document.getElementById('ia-panel-memory-mode');
    mode.value = 'existing';
    mode.dispatchEvent(new Event('change'));
    const commands = chrome.runtime.sendMessage.mock.calls.map(([message]) => message);
    expect(commands).toContainEqual({
      type: 'IA_PANEL_COMMAND', command: 'editMemoryBullet',
      data: { id: 'bullet-1', text: 'Editado desde panel' }
    });
    expect(commands).toContainEqual({
      type: 'IA_PANEL_COMMAND', command: 'exportMemory', data: { format: 'md' }
    });
    expect(commands).toContainEqual({
      type: 'IA_PANEL_COMMAND', command: 'setMemoryMode', data: { mode: 'existing' }
    });
  });
});
