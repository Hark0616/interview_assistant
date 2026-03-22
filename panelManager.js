// panelManager.js — Gestión del ciclo de vida de la ventana pop-out (panel)
// Se importa en background.js vía importScripts().
// Escucha mensajes IA_OPEN_PANEL, IA_PANEL_READY, IA_PANEL_COMMAND, IA_PANEL_STATE
// y gestiona la ventana separada + relay de mensajes al content script.

(function () {
  'use strict';

  let panelState = { windowId: null, meetTabId: null };

  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === panelState.windowId) {
      const tabId = panelState.meetTabId;
      panelState = { windowId: null, meetTabId: null };
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'IA_PANEL_CLOSED' }).catch(() => {});
      }
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'IA_OPEN_PANEL') {
      const meetTabId = sender.tab?.id;
      if (!meetTabId) { sendResponse({ success: false }); return; }

      if (panelState.windowId) {
        chrome.windows.update(panelState.windowId, { focused: true }).catch(() => {});
        sendResponse({ success: true, alreadyOpen: true });
        return;
      }

      chrome.windows.create({
        url: 'panel.html',
        type: 'popup',
        width: 420,
        height: 680,
        left: 40,
        top: 60,
      }, (win) => {
        panelState.windowId = win.id;
        panelState.meetTabId = meetTabId;
        sendResponse({ success: true });
      });
      return true;
    }

    if (request.type === 'IA_PANEL_READY') {
      if (panelState.meetTabId) {
        chrome.tabs.sendMessage(panelState.meetTabId, { type: 'IA_PANEL_READY' }).catch(() => {});
      }
      return;
    }

    if (request.type === 'IA_PANEL_COMMAND') {
      if (panelState.meetTabId) {
        chrome.tabs.sendMessage(panelState.meetTabId, request).catch(() => {});
      }
      return;
    }

    // Ignorar actualizaciones de estado del panel (las recibe panel.js directamente)
    if (request.type === 'IA_PANEL_STATE') return;
  });
})();
