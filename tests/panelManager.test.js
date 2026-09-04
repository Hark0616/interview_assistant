import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const PANEL_STATE_STORAGE_KEY = 'iaPanelAssociation';

describe('panelManager.js - asociación segura del pop-out', () => {
  let onMessage;
  let onRemoved;
  let storageState;

  function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function openFromTab(tabId) {
    return new Promise((resolve) => {
      onMessage({ type: 'IA_OPEN_PANEL' }, { tab: { id: tabId } }, resolve);
    });
  }

  beforeEach(() => {
    global.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener: vi.fn((listener) => { onMessage = listener; }) },
      },
      storage: {
        session: {
          get: vi.fn((_keys, callback) => callback({ [PANEL_STATE_STORAGE_KEY]: storageState })),
          set: vi.fn((value, callback) => {
            storageState = value[PANEL_STATE_STORAGE_KEY];
            callback?.();
          }),
        },
      },
      windows: {
        onRemoved: { addListener: vi.fn((listener) => { onRemoved = listener; }) },
        create: vi.fn((_options, callback) => callback({ id: 700 })),
        get: vi.fn((id, callback) => callback({ id })),
        update: vi.fn(() => Promise.resolve()),
      },
      tabs: {
        sendMessage: vi.fn(() => Promise.resolve()),
      },
    };
    storageState = null;

    const code = fs.readFileSync(path.resolve(__dirname, '../panelManager.js'), 'utf8');
    eval(code);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asocia el panel a la pestaña que lo abrió y persiste la asociación', async () => {
    const response = await openFromTab(101);

    expect(response).toEqual({ success: true });
    expect(storageState).toEqual({ windowId: 700, meetTabId: 101 });
    expect(chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'panel.html', type: 'popup' }),
      expect.any(Function)
    );
  });

  it('no permite que otra reunión controle el panel existente', async () => {
    await openFromTab(101);
    const response = await openFromTab(202);

    expect(response).toMatchObject({ success: false, alreadyOpen: true });
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('serializa dos clics simultáneos para no abrir dos ventanas', async () => {
    const first = openFromTab(101);
    const second = openFromTab(202);
    const responses = await Promise.all([first, second]);

    expect(responses[0]).toEqual({ success: true });
    expect(responses[1]).toMatchObject({ success: false, alreadyOpen: true });
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('redirige READY y comandos exclusivamente a la pestaña asociada', async () => {
    await openFromTab(101);

    onMessage({ type: 'IA_PANEL_READY' }, { tab: { id: 700 } }, vi.fn());
    onMessage({ type: 'IA_PANEL_COMMAND', command: 'setMode', data: { manual: true } }, { tab: { id: 700 } }, vi.fn());
    await tick();

    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(1, 101, { type: 'IA_PANEL_READY' });
    expect(chrome.tabs.sendMessage).toHaveBeenNthCalledWith(2, 101, {
      type: 'IA_PANEL_COMMAND', command: 'setMode', data: { manual: true }
    });
  });

  it('recupera la asociación después de recrear el service worker', async () => {
    await openFromTab(101);

    const code = fs.readFileSync(path.resolve(__dirname, '../panelManager.js'), 'utf8');
    eval(code);

    onMessage({ type: 'IA_PANEL_READY' }, { tab: { id: 700 } }, vi.fn());
    await tick();

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'IA_PANEL_READY' });
  });

  it('libera la asociación y avisa a Meet cuando se cierra la ventana', async () => {
    await openFromTab(101);

    onRemoved(700);
    await tick();

    expect(storageState).toEqual({ windowId: null, meetTabId: null });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'IA_PANEL_CLOSED' });
  });

  it('devuelve error controlado si Chrome no puede crear el panel', async () => {
    chrome.windows.create.mockImplementation((_options, callback) => {
      chrome.runtime.lastError = { message: 'Permiso denegado' };
      callback();
      chrome.runtime.lastError = null;
    });

    const response = await openFromTab(101);

    expect(response).toEqual({ success: false, error: 'Permiso denegado' });
    expect(storageState).toBeNull();
  });

  it('devuelve error controlado si no puede enfocar un panel existente', async () => {
    await openFromTab(101);
    chrome.windows.update.mockRejectedValueOnce(new Error('Ventana cerrada'));

    const response = await openFromTab(101);

    expect(response).toEqual({ success: false, error: 'Ventana cerrada' });
    expect(storageState).toEqual({ windowId: null, meetTabId: null });
  });
});
