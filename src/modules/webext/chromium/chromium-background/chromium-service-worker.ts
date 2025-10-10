/* global globalThis */
import browser, { Alarms, Runtime } from 'webextension-polyfill';

type ServiceWorkerEventMessage =
  | { type: 'alarm'; alarm: Alarms.Alarm }
  | { type: 'notification-clicked'; notificationId: string }
  | { type: 'notification-closed'; notificationId: string }
  | { type: 'runtime-installed'; details: Runtime.OnInstalledDetailsType }
  | { type: 'runtime-startup' }
  | { type: 'runtime-message'; payload: unknown; requestId: string };

type OffscreenInboundMessage =
  | { type: 'offscreen-ready' }
  | { type: 'runtime-response'; requestId: string; success: true; result: unknown }
  | { type: 'runtime-response'; requestId: string; success: false; error: SerializedError };

interface SerializedError {
  message: string;
  name: string;
}

interface PendingRequest {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
}

interface ReadyWaiter {
  reject: (reason: Error) => void;
  resolve: () => void;
}

const OFFSCREEN_DOCUMENT_URL = 'background.html';
const OFFSCREEN_JUSTIFICATION =
  'Runs the AngularJS background module inside an offscreen document to preserve existing functionality.';
const OFFSCREEN_REASON = 'DOM_SCRAPING';
const PORT_NAME = 'webext-background';

const getGlobalScope = (): any => {
  if (typeof globalThis !== 'undefined') {
    return globalThis;
  }
  if (typeof window !== 'undefined') {
    return window;
  }
  return undefined;
};

const getChrome = (): any => {
  const scope = getGlobalScope();
  return scope?.chrome;
};

const logError = (message: string, error?: unknown): void => {
  /* eslint-disable-next-line no-console */
  console.error(message, error);
};

const logWarning = (message: string): void => {
  /* eslint-disable-next-line no-console */
  console.warn(message);
};

const pendingRequests = new Map<string, PendingRequest>();
const readyWaiters: ReadyWaiter[] = [];

let backgroundPort: any = null;
let offscreenReady = false;
let creatingOffscreen: Promise<void> | null = null;

const toPromise = <T>(value: Promise<T> | T): Promise<T> => {
  if (value && typeof (value as Promise<T>).then === 'function') {
    return value as Promise<T>;
  }
  return Promise.resolve(value as T);
};

const generateRequestId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const reviveError = (error?: SerializedError): Error => {
  if (!error) {
    return new Error('BackgroundError');
  }
  const revived = new Error(error.message || 'BackgroundError');
  revived.name = error.name || 'Error';
  return revived;
};

const resolveReadyWaiters = (): void => {
  offscreenReady = true;
  while (readyWaiters.length) {
    const waiter = readyWaiters.shift();
    waiter?.resolve();
  }
};

const rejectReadyWaiters = (reason: Error): void => {
  while (readyWaiters.length) {
    const waiter = readyWaiters.shift();
    waiter?.reject(reason);
  }
};

const rejectPendingRequests = (reason: Error): void => {
  pendingRequests.forEach((pending) => pending.reject(reason));
  pendingRequests.clear();
};

const createOffscreenDocumentIfNeeded = async (): Promise<void> => {
  const chromeApi = getChrome();
  if (!chromeApi?.offscreen) {
    throw new Error('chrome.offscreen API is not available.');
  }

  const hasDocument =
    typeof chromeApi.offscreen.hasDocument === 'function' ? await toPromise(chromeApi.offscreen.hasDocument()) : false;

  if (!hasDocument) {
    await toPromise(
      chromeApi.offscreen.createDocument({
        justification: OFFSCREEN_JUSTIFICATION,
        reasons: [OFFSCREEN_REASON],
        url: OFFSCREEN_DOCUMENT_URL
      })
    );
  }
};

const closeOffscreenDocument = async (): Promise<void> => {
  const chromeApi = getChrome();
  if (!chromeApi?.offscreen?.closeDocument) {
    return;
  }
  await toPromise(chromeApi.offscreen.closeDocument());
};

const waitForOffscreenReady = async (): Promise<void> => {
  if (offscreenReady && backgroundPort) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    readyWaiters.push({ reject, resolve });
  });
};

const ensureOffscreenDocument = async (): Promise<void> => {
  if (offscreenReady && backgroundPort) {
    return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = createOffscreenDocumentIfNeeded().catch((error) => {
      creatingOffscreen = null;
      throw error;
    });
  }

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }

  if (!offscreenReady || !backgroundPort) {
    await waitForOffscreenReady();
  }
};

const postToOffscreen = async (message: ServiceWorkerEventMessage): Promise<void> => {
  await ensureOffscreenDocument();
  if (!backgroundPort) {
    throw new Error('Offscreen document port is unavailable.');
  }
  backgroundPort.postMessage(message);
};

const handleOffscreenMessage = (message: OffscreenInboundMessage): void => {
  switch (message.type) {
    case 'offscreen-ready':
      resolveReadyWaiters();
      break;
    case 'runtime-response': {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      pendingRequests.delete(message.requestId);
      if (message.success) {
        pending.resolve(message.result);
      } else {
        const errorMessage = (
          message as {
            error: SerializedError;
            success: false;
          }
        ).error;
        pending.reject(reviveError(errorMessage));
      }
      break;
    }
    default:
  }
};

const chromeApi = getChrome();
if (chromeApi?.runtime?.onConnect) {
  chromeApi.runtime.onConnect.addListener((port: any) => {
    if (port.name !== PORT_NAME) {
      return;
    }

    backgroundPort = port;
    offscreenReady = false;

    port.onMessage.addListener((msg: OffscreenInboundMessage) => handleOffscreenMessage(msg));
    port.onDisconnect.addListener(() => {
      backgroundPort = null;
      offscreenReady = false;
      rejectReadyWaiters(new Error('Offscreen document was disconnected.'));
      rejectPendingRequests(new Error('Offscreen document was disconnected.'));
      closeOffscreenDocument().catch((error: Error) => {
        logError('Failed to close offscreen document', error);
      });
    });
  });
}

browser.runtime.onMessage.addListener((message) => {
  return new Promise((resolve, reject) => {
    ensureOffscreenDocument()
      .then(() => {
        if (!backgroundPort) {
          throw new Error('Offscreen document port is unavailable.');
        }
        const requestId = generateRequestId();
        pendingRequests.set(requestId, { reject, resolve });
        backgroundPort.postMessage({
          payload: message,
          requestId,
          type: 'runtime-message'
        } as ServiceWorkerEventMessage);
      })
      .catch((error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
});

browser.runtime.onInstalled.addListener((details) => {
  postToOffscreen({ details, type: 'runtime-installed' }).catch((error) => {
    logError('Failed to forward runtime.onInstalled event', error);
  });
});

browser.runtime.onStartup.addListener(() => {
  postToOffscreen({ type: 'runtime-startup' }).catch((error) => {
    logError('Failed to forward runtime.onStartup event', error);
  });
});

browser.alarms.onAlarm.addListener((alarm) => {
  postToOffscreen({ alarm, type: 'alarm' }).catch((error) => {
    logError('Failed to forward alarms.onAlarm event', error);
  });
});

browser.notifications.onClicked.addListener((notificationId: string) => {
  postToOffscreen({ notificationId, type: 'notification-clicked' }).catch((error) => {
    logError('Failed to forward notifications.onClicked event', error);
  });
});

browser.notifications.onClosed.addListener((notificationId: string) => {
  postToOffscreen({ notificationId, type: 'notification-closed' }).catch((error) => {
    logError('Failed to forward notifications.onClosed event', error);
  });
});

if (browser.runtime.getManifest().manifest_version !== 3) {
  logWarning('Chromium MV3 service worker loaded in a non-MV3 context.');
}
