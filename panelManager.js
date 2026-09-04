// panelManager.js — Gestión del ciclo de vida de la ventana pop-out (panel)
// Se importa en background.js vía importScripts().
// Escucha mensajes IA_OPEN_PANEL, IA_PANEL_READY, IA_PANEL_COMMAND, IA_PANEL_STATE
// y gestiona la ventana separada + relay de mensajes al content script.

(function () {
  'use strict';

  const PANEL_STATE_STORAGE_KEY = 'iaPanelAssociation';
  let panelState = { windowId: null, meetTabId: null };
  let panelStateReady = false;
  let panelOpenInFlight = null;

  function getPanelStorage() {
    return chrome.storage?.session || chrome.storage?.local || null;
  }

  function persistPanelState() {
    const storage = getPanelStorage();
    if (!storage?.set) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        storage.set({ [PANEL_STATE_STORAGE_KEY]: panelState }, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  const panelStateReadyPromise = new Promise((resolve) => {
    const storage = getPanelStorage();
    if (!storage?.get) {
      panelStateReady = true;
      resolve();
      return;
    }

    try {
      storage.get([PANEL_STATE_STORAGE_KEY], (result) => {
        const stored = result?.[PANEL_STATE_STORAGE_KEY];
        if (Number.isInteger(stored?.windowId) && Number.isInteger(stored?.meetTabId)) {
          panelState = { windowId: stored.windowId, meetTabId: stored.meetTabId };
        }
        panelStateReady = true;
        resolve();
      });
    } catch {
      panelStateReady = true;
      resolve();
    }
  });

  function ensurePanelStateReady() {
    return panelStateReady ? Promise.resolve() : panelStateReadyPromise;
  }

  function clearPanelState() {
    panelState = { windowId: null, meetTabId: null };
    return persistPanelState();
  }

  function sendTabMessage(tabId, message) {
    if (tabId == null) return;
    try {
      const result = chrome.tabs.sendMessage(tabId, message);
      result?.catch?.(() => {});
    } catch {
      // La pestaña puede haberse cerrado entre la lectura y el relay.
    }
  }

  function getWindowExists(windowId) {
    if (windowId == null || !chrome.windows?.get) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        chrome.windows.get(windowId, (win) => {
          resolve(!chrome.runtime?.lastError && !!win?.id);
        });
      } catch {
        resolve(false);
      }
    });
  }

  chrome.windows.onRemoved.addListener((windowId) => {
    void ensurePanelStateReady().then(async () => {
      if (windowId !== panelState.windowId) return;
      const tabId = panelState.meetTabId;
      await clearPanelState();
      sendTabMessage(tabId, { type: 'IA_PANEL_CLOSED' });
    });
  });

  async function openPanelInternal(sender, sendResponse) {
    const meetTabId = sender.tab?.id;
    if (meetTabId == null) {
      sendResponse({ success: false, error: 'No se encontró la pestaña de la reunión.' });
      return;
    }

    await ensurePanelStateReady();

    if (panelState.windowId != null) {
      if (!await getWindowExists(panelState.windowId)) {
        await clearPanelState();
      } else if (panelState.meetTabId !== meetTabId) {
        sendResponse({
          success: false,
          alreadyOpen: true,
          error: 'Ya existe un panel asociado a otra pestaña de reunión.'
        });
        return;
      } else {
        try {
          await chrome.windows.update(panelState.windowId, { focused: true });
          sendResponse({ success: true, alreadyOpen: true });
        } catch (err) {
          await clearPanelState();
          sendResponse({ success: false, error: err?.message || 'No se pudo enfocar el panel.' });
        }
        return;
      }
    }

    try {
      chrome.windows.create({
        url: 'panel.html',
        type: 'popup',
        width: 420,
        height: 680,
        left: 40,
        top: 60,
      }, async (win) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError || !win?.id) {
          sendResponse({ success: false, error: lastError?.message || 'No se pudo crear el panel.' });
          return;
        }
        panelState = { windowId: win.id, meetTabId };
        await persistPanelState();
        sendResponse({ success: true });
      });
    } catch (err) {
      sendResponse({ success: false, error: err?.message || 'No se pudo crear el panel.' });
    }
  }

  function openPanel(sender, sendResponse) {
    const previous = panelOpenInFlight || Promise.resolve();
    const current = previous.then(async () => {
      try {
        await openPanelInternal(sender, sendResponse);
      } catch (err) {
        sendResponse({ success: false, error: err?.message || 'No se pudo abrir el panel.' });
      }
    });
    panelOpenInFlight = current;
    void current.finally(() => {
      if (panelOpenInFlight === current) panelOpenInFlight = null;
    });
    return current;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'IA_OPEN_PANEL') {
      void openPanel(sender, sendResponse);
      return true;
    }

    if (request.type === 'IA_PANEL_READY') {
      void ensurePanelStateReady().then(() => {
        sendTabMessage(panelState.meetTabId, { type: 'IA_PANEL_READY' });
      });
      return;
    }

    if (request.type === 'IA_PANEL_COMMAND') {
      void ensurePanelStateReady().then(() => {
        sendTabMessage(panelState.meetTabId, request);
      });
      return;
    }

    // Ignorar actualizaciones de estado del panel (las recibe panel.js directamente)
    if (request.type === 'IA_PANEL_STATE') return;
  });
})();
