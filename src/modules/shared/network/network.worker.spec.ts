/** @jest-environment node */
/* global globalThis */
import { NetworkService } from './network.service';

jest.mock('angular-ts-decorators', () => ({ Injectable: () => (target: unknown) => target }));

describe('NetworkService in a service worker', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  afterEach(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  test.each([true, false])('returns navigator.onLine=%s without window', (onLine) => {
    expect(typeof window).toBe('undefined');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine } });
    const service = new NetworkService(undefined as any);
    expect(service.isNetworkConnected()).toBe(onLine);
  });
});
