
// background.ts

const MAX_LOGS = 100;
const EXTENSION_ID = chrome.runtime.id;

// Store pending requests in memory to correlate headers/body/completion
const pendingRequests: Record<string, any> = {};

const updateBadge = (recording: boolean) => {
  if (chrome.action) {
    if (recording) {
      chrome.action.setBadgeText({ text: "REC" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  }
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ isRecording: false, logs: [] });
  updateBadge(false);
  // Clear any existing dynamic rules on startup
  chrome.declarativeNetRequest.updateSessionRules({
     removeRuleIds: [1]
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.isRecording) {
    updateBadge(changes.isRecording.newValue);
  }
});

// --- DNR Rule Manager for Header Overrides ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SET_REQUEST_HEADERS') {
        const { url, headers } = message;
        const ruleId = 1;
        const requestHeaders = headers.map((h: any) => ({
            header: h.key || h.name,
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: h.value
        }));

        const cleanUrl = url.split('?')[0];

        const rule = {
            id: ruleId,
            priority: 999,
            action: {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                requestHeaders: requestHeaders
            },
            condition: {
                urlFilter: cleanUrl,
                // Only modify headers for API requests (fetch/XHR)
                resourceTypes: [
                    chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST
                ]
            }
        };

        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
            addRules: [rule]
        }).then(() => {
            sendResponse({ success: true });
        }).catch(err => {
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.type === 'CLEAR_REQUEST_HEADERS') {
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [1]
        }).then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
});

// --- Storage Queue ---
let isSaving = false;
const saveQueue: any[] = [];

const processQueue = () => {
    if (isSaving || saveQueue.length === 0) return;

    isSaving = true;
    const logToSave = saveQueue.shift();

    chrome.storage.local.get(['logs'], (result) => {
        const currentLogs = result.logs || [];
        const idx = currentLogs.findIndex((l: any) => l.id === logToSave.id);
        let newLogs;

        if (idx !== -1) {
            // Merge update into existing entry
            currentLogs[idx] = { ...currentLogs[idx], ...logToSave };
            newLogs = currentLogs;
        } else {
            // Don't save partial logs that don't at least have a URL
            if (!logToSave.url) {
                isSaving = false;
                if (saveQueue.length > 0) processQueue();
                return;
            }
            newLogs = [logToSave, ...currentLogs].slice(0, MAX_LOGS);
        }

        chrome.storage.local.set({ logs: newLogs }, () => {
            isSaving = false;
            if (saveQueue.length > 0) processQueue();
        });
    });
};

const saveLog = (log: any) => {
  saveQueue.push({ ...log }); // Push a copy
  processQueue();
};

const isExtensionRequest = (details: any) => {
    return (
        details.initiator?.includes(EXTENSION_ID) ||
        details.url.startsWith('chrome-extension://') ||
        details.url.startsWith('data:') ||
        details.url.startsWith('blob:')
    );
};

/**
 * Filter for API requests only.
 * In Chrome's webRequest API, 'xmlhttprequest' covers both XHR and Fetch.
 */
const isApiRequest = (details: any) => {
    return details.type === 'xmlhttprequest';
};

// Internal helper to get or create a pending request object
const getOrCreatePending = (requestId: string) => {
    if (!pendingRequests[requestId]) {
        pendingRequests[requestId] = {
            id: requestId,
            status: 0,
            timestamp: Date.now(),
            requestHeaders: {},
            responseHeaders: {}
        };
    }
    return pendingRequests[requestId];
};

// 1. Capture Basic Info & Body
chrome.webRequest.onBeforeRequest.addListener(
  (details: any) => {
    if (isExtensionRequest(details) || details.type === 'ping' || !isApiRequest(details)) return;

    chrome.storage.local.get(['isRecording'], (result) => {
      if (!result.isRecording) return;

      const log = getOrCreatePending(details.requestId);
      log.url = details.url;
      log.method = details.method;
      log.type = details.type;

      if (details.requestBody) {
        if (details.requestBody.raw && details.requestBody.raw[0]) {
           const enc = new TextDecoder("utf-8");
           try { log.requestBody = enc.decode(details.requestBody.raw[0].bytes); }
           catch (e) { log.requestBody = "[Binary Data]"; }
        } else if (details.requestBody.formData) {
           log.requestBody = details.requestBody.formData;
        }
      }

      saveLog(log);
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// 2. Capture Request Headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details: any) => {
    if (isExtensionRequest(details) || !isApiRequest(details)) return;

    chrome.storage.local.get(['isRecording'], (result) => {
        if (!result.isRecording) return;

        const log = getOrCreatePending(details.requestId);
        const headers: Record<string, string> = {};
        details.requestHeaders?.forEach((h: any) => { headers[h.name] = h.value || ''; });
        log.requestHeaders = { ...log.requestHeaders, ...headers };

        saveLog(log);
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// 3. Capture Response Headers
chrome.webRequest.onHeadersReceived.addListener(
  (details: any) => {
    if (isExtensionRequest(details) || !isApiRequest(details)) return;

    chrome.storage.local.get(['isRecording'], (result) => {
        if (!result.isRecording) return;

        const log = getOrCreatePending(details.requestId);
        const headers: Record<string, string> = {};
        details.responseHeaders?.forEach((h: any) => { headers[h.name] = h.value || ''; });
        log.responseHeaders = { ...log.responseHeaders, ...headers };

        saveLog(log);
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

// 4. Capture Completion
chrome.webRequest.onCompleted.addListener(
  (details: any) => {
    if (pendingRequests[details.requestId] && isApiRequest(details)) {
      const log = pendingRequests[details.requestId];
      log.status = details.statusCode;
      saveLog(log);
      // Clean up after a short delay to allow last-second async tasks
      setTimeout(() => { delete pendingRequests[details.requestId]; }, 2000);
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details: any) => {
    if (pendingRequests[details.requestId] && isApiRequest(details)) {
      const log = pendingRequests[details.requestId];
      log.status = 0;
      log.error = details.error;
      saveLog(log);
      delete pendingRequests[details.requestId];
    }
  },
  { urls: ["<all_urls>"] }
);
