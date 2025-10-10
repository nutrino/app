import browser, { Alarms, Runtime } from 'webextension-polyfill';
import { WebExtBackgroundService } from '../../webext-background/webext-background.service';

type OffscreenInboundMessage =
  | { type: 'alarm'; alarm: Alarms.Alarm }
  | { type: 'notification-clicked'; notificationId: string }
  | { type: 'notification-closed'; notificationId: string }
  | { type: 'runtime-installed'; details: Runtime.OnInstalledDetailsType }
  | { type: 'runtime-message'; payload: unknown; requestId: string }
  | { type: 'runtime-startup' };

type OffscreenOutboundMessage =
  | { type: 'offscreen-ready' }
  | { type: 'runtime-response'; requestId: string; success: true; result: unknown }
  | { type: 'runtime-response'; requestId: string; success: false; error: SerializedError };

interface SerializedError {
  message: string;
  name: string;
}

const PORT_NAME = 'webext-background';

const isManifestV3 = () => {
  try {
    return browser.runtime.getManifest().manifest_version === 3;
  } catch (err) {
    return false;
  }
};

const serializeError = (error: unknown): SerializedError => {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name ?? 'Error'
    };
  }

  return {
    message: typeof error === 'string' ? error : 'UnknownError',
    name: 'Error'
  };
};

export const initializeOffscreenBridge = (backgroundSvc: WebExtBackgroundService): void => {
  if (!isManifestV3()) {
    return;
  }

  const chromeApi = (globalThis as any).chrome;
  if (!(chromeApi?.runtime?.connect)) {
    return;
  }

  const port = chromeApi.runtime.connect({ name: PORT_NAME });

  port.onMessage.addListener(async (message: OffscreenInboundMessage) => {
    switch (message.type) {
      case 'alarm':
        backgroundSvc.onAlarm(message.alarm);
        break;
      case 'notification-clicked':
        backgroundSvc.onNotificationClicked(message.notificationId);
        break;
      case 'notification-closed':
        backgroundSvc.onNotificationClosed(message.notificationId);
        break;
      case 'runtime-installed':
        backgroundSvc.handleRuntimeInstalled(message.details).catch((error) => {
          console.error('Failed to process runtime.onInstalled event', error);
        });
        break;
      case 'runtime-startup':
        backgroundSvc.init().catch((error) => {
          console.error('Failed to run startup initialisation', error);
        });
        break;
      case 'runtime-message': {
        try {
          const result = await backgroundSvc.onMessage(message.payload as any);
          port.postMessage({
            requestId: message.requestId,
            result,
            success: true,
            type: 'runtime-response'
          } as OffscreenOutboundMessage);
        } catch (error) {
          port.postMessage({
            error: serializeError(error),
            requestId: message.requestId,
            success: false,
            type: 'runtime-response'
          } as OffscreenOutboundMessage);
        }
        break;
      }
      default:
    }
  });

  port.postMessage({ type: 'offscreen-ready' } as OffscreenOutboundMessage);
};
