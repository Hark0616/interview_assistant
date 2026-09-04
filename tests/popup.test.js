/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('popup.js - configuración y lenguaje de respuesta', () => {
  let storedConfig;

  function loadPopup() {
    const html = fs.readFileSync(path.resolve(__dirname, '../popup.html'), 'utf8')
      .replace(/<script[\s\S]*?<\/script>/g, '');
    document.open();
    document.write(html);
    document.close();
    const utils = fs.readFileSync(path.resolve(__dirname, '../utils.js'), 'utf8');
    const popup = fs.readFileSync(path.resolve(__dirname, '../popup.js'), 'utf8');
    eval(utils);
    eval(popup);
    document.dispatchEvent(new Event('DOMContentLoaded'));
  }

  beforeEach(() => {
    storedConfig = null;
    global.chrome = {
      runtime: {
        getManifest: vi.fn(() => ({ version: '1.7.1' })),
        sendMessage: vi.fn((_message, callback) => {
          callback?.({ success: false, error: 'sin catálogo en prueba', models: [] });
          return Promise.resolve({ success: false });
        }),
      },
      storage: {
        local: {
          get: vi.fn((_keys, callback) => callback({ iaConfig: storedConfig })),
          set: vi.fn((value, callback) => {
            storedConfig = value.iaConfig;
            callback?.();
          }),
        },
      },
      tabs: {
        query: vi.fn((_query, callback) => callback([{
          id: 99,
          url: 'https://meet.google.com/abc-defg-hij',
        }])),
        sendMessage: vi.fn(() => Promise.resolve()),
      },
    };
    window.__ia = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('inicia en español cuando no hay configuración guardada y valida falta de API key', () => {
    loadPopup();

    expect(document.getElementById('response-language-es').classList.contains('active')).toBe(true);
    expect(document.getElementById('response-language-en').classList.contains('active')).toBe(false);
    expect(document.getElementById('model').options.length).toBeGreaterThan(0);

    document.getElementById('response-language-en').click();
    expect(document.getElementById('response-language-en').getAttribute('aria-pressed')).toBe('true');
    document.getElementById('save-btn').click();
    expect(document.getElementById('save-result').textContent).toContain('API Key');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('normaliza idioma inválido, permite seleccionar inglés y lo propaga al guardar en Meet', async () => {
    storedConfig = {
      apiKey: 'key', apiKeys: { gemini: 'key' }, provider: 'gemini',
      model: 'gemini-flash-latest', responseLanguage: 'fr', myName: 'María López'
    };
    loadPopup();

    expect(document.getElementById('response-language-es').classList.contains('active')).toBe(true);
    document.getElementById('response-language-en').click();
    document.getElementById('save-btn').click();
    await Promise.resolve();

    expect(storedConfig.responseLanguage).toBe('en');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, { type: 'CONFIG_UPDATED' });
    expect(document.getElementById('footer-version').textContent).toBe('v1.7.1');
  });
});
