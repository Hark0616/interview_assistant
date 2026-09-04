/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const contentScripts = [
  'utils.js',
  'captionCapture.js',
  'sessionLog.js',
  'memoryLedger.js',
  'aiClient.js',
  'overlayUI.js',
  'content.js',
];

describe('integración content script en una página Meet', () => {
  let config;
  let runtimeMessageListener;
  let storage;

  function loadScript(file) {
    const code = fs.readFileSync(path.resolve(__dirname, `../${file}`), 'utf8');
    eval(code);
  }

  function block(speaker, text) {
    const el = document.createElement('div');
    el.className = 'nMcdL bj4p3b';
    el.innerHTML = '<span class="NWpY1d"></span><span class="ygicle"></span>';
    el.querySelector('.NWpY1d').textContent = speaker;
    el.querySelector('.ygicle').textContent = text;
    return el;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    window.__ia = {};
    document.body.innerHTML = '<button aria-label="camera"></button>';
    config = {
      apiKey: 'test-key',
      provider: 'gemini',
      model: 'gemini-flash-latest',
      myName: 'María López',
      manualMode: true,
      responseLanguage: 'invalid',
    };
    storage = { iaConfig: config };
    global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    global.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener: vi.fn((listener) => { runtimeMessageListener = listener; }) },
        sendMessage: vi.fn(() => Promise.resolve({ success: true })),
        connect: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn((keys, callback) => {
            const requested = Array.isArray(keys) ? keys : [keys];
            callback(requested.includes('iaConfig') ? { iaConfig: storage.iaConfig } : storage);
          }),
          set: vi.fn((value, callback) => {
            Object.assign(storage, value);
            callback?.();
          }),
        },
      },
      tabs: {
        query: vi.fn((_, callback) => callback([])),
        sendMessage: vi.fn(() => Promise.resolve()),
      },
    };

    for (const script of contentScripts) loadScript(script);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete global.requestAnimationFrame;
  });

  it('inicializa Meet, activa captura, normaliza idioma y procesa captions ya visibles', async () => {
    document.body.appendChild(block('Ivan Fuentes', 'Could you describe a production incident?'));

    // content.js espera a que aparezca una señal de Meet y después arranca el overlay.
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.getElementById('ia-interview-overlay')).not.toBeNull();
    expect(document.getElementById('ia-language-es').classList.contains('active')).toBe(true);

    document.getElementById('ia-activate-btn').click();
    await vi.advanceTimersByTimeAsync(20);

    expect(document.getElementById('ia-activate-btn').textContent).toBe('Detener');
    expect(document.getElementById('ia-transcript').textContent).toContain('Could you describe a production incident?');
    expect(document.getElementById('ia-transcript').textContent).toContain('Ivan Fuentes');

    document.getElementById('ia-language-en').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.getElementById('ia-language-en').classList.contains('active')).toBe(true);
    expect(storage.iaConfig.responseLanguage).toBe('en');

    const late = block('María López', 'I would start by containing the impact.');
    document.body.appendChild(late);
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById('ia-transcript').textContent).toContain('I would start by containing the impact.');
    expect(document.querySelector('#ia-transcript .ia-me')).not.toBeNull();

    runtimeMessageListener({ type: 'CONFIG_UPDATED' });
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById('ia-language-en').classList.contains('active')).toBe(true);

    document.getElementById('ia-activate-btn').click();
    const before = document.getElementById('ia-transcript').textContent;
    document.body.appendChild(block('Ivan Fuentes', 'This one must not appear after stopping.'));
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById('ia-transcript').textContent).toBe(before);
  });

  it('rechaza activar sin API key y no inicia el observer', async () => {
    config.apiKey = '';
    await vi.advanceTimersByTimeAsync(4000);

    document.getElementById('ia-activate-btn').click();
    expect(document.getElementById('ia-activate-btn').textContent).toBe('Activar');
    expect(document.getElementById('ia-status-text').textContent).toContain('Configura el API key');
  });
});
