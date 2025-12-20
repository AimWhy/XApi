
// background.ts

const MAX_LOGS = 100;
const EXTENSION_ID = chrome.runtime.id;

// Store pending requests in memory to correlate headers/body/completion
const pendingRequests: Record<string, any> = {};

const updateBadge = (recording: boolean) => {
  if (recording) {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  } else {
    chrome.action.setBadgeText({ text: "" });
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

        // 构建 Header 列表，使用 SET 操作进行覆盖
        const requestHeaders = headers.map((h: any) => ({
            header: h.key || h.name, 
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: h.value
        }));

        // 提取 Host 用于更精确的 urlFilter，或者直接使用传入的 URL
        // 使用锚点 | 确保精确匹配起始位置，移除查询参数避免 Pattern 冲突
        const cleanUrl = url.split('?')[0];

        const rule = {
            id: ruleId,
            priority: 999, // 提高优先级，确保覆盖浏览器默认行为
            action: {
                type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                requestHeaders: requestHeaders
            },
            condition: {
                urlFilter: cleanUrl, 
                resourceTypes: [
                    chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST, // fetch 本质也是此类型
                    chrome.declarativeNetRequest.ResourceType.OTHER
                ]
            }
        };

        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [ruleId],
            addRules: [rule]
        }).then(() => {
            console.debug('DNR Rule Applied for Cookie/Origin override');
            sendResponse({ success: true });
        }).catch(err => {
            console.error('DNR Error:', err);
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
            currentLogs[idx] = { ...currentLogs[idx], ...logToSave };
            newLogs = currentLogs;
        } else {
            newLogs = [logToSave, ...currentLogs].slice(0, MAX_LOGS);
        }

        chrome.storage.local.set({ logs: newLogs }, () => {
            isSaving = false;
            if (saveQueue.length > 0) processQueue();
        });
    });
};

const saveLog = (log: any) => {
  if (!log.url && !log.id) return;
  saveQueue.push(log);
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

// 1. Capture Request Body & Basic Info
chrome.webRequest.onBeforeRequest.addListener(
  (details: any) => {
    if (isExtensionRequest(details) || details.type === 'ping') return;

    chrome.storage.local.get(['isRecording'], (result) => {
      if (!result.isRecording) return;
      if (details.type !== 'xmlhttprequest' && details.type !== 'fetch' && details.type !== 'main_frame') return;

      const log: any = {
        id: details.requestId,
        url: details.url,
        method: details.method,
        status: 0,
        timestamp: Date.now(),
        type: details.type,
      };

      if (details.requestBody) {
        if (details.requestBody.raw && details.requestBody.raw[0]) {
           const enc = new TextDecoder("utf-8");
           try { log.requestBody = enc.decode(details.requestBody.raw[0].bytes); } 
           catch (e) { log.requestBody = "[Binary Data]"; }
        } else if (details.requestBody.formData) {
           log.requestBody = details.requestBody.formData;
        }
      }
      
      pendingRequests[details.requestId] = log;
      saveLog(log);
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// 2. Capture Request Headers
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details: any) => {
    if (!pendingRequests[details.requestId]) return;
    const headers: Record<string, string> = {};
    details.requestHeaders?.forEach((h: any) => { headers[h.name] = h.value || ''; });
    const update = { id: details.requestId, requestHeaders: headers };
    pendingRequests[details.requestId] = { ...pendingRequests[details.requestId], ...update };
    saveLog(update);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// 3. Capture Response Headers
chrome.webRequest.onHeadersReceived.addListener(
  (details: any) => {
    if (!pendingRequests[details.requestId]) return;
    const headers: Record<string, string> = {};
    details.responseHeaders?.forEach((h: any) => { headers[h.name] = h.value || ''; });
    const update = { id: details.requestId, responseHeaders: headers };
    pendingRequests[details.requestId] = { ...pendingRequests[details.requestId], ...update };
    saveLog(update);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

// 4. Capture Completion
chrome.webRequest.onCompleted.addListener(
  (details: any) => {
    if (pendingRequests[details.requestId]) {
      const update = { id: details.requestId, status: details.statusCode };
      saveLog(update);
      setTimeout(() => { delete pendingRequests[details.requestId]; }, 5000);
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details: any) => {
    if (pendingRequests[details.requestId]) {
      const update = { id: details.requestId, status: 0, error: details.error };
      saveLog(update);
      delete pendingRequests[details.requestId];
    }
  },
  { urls: ["<all_urls>"] }
);
