import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPermissionGranted, onAction, requestPermission } from '@tauri-apps/plugin-notification';
import { selectNode, toast } from './store';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol';
vi.mock('./url', () => ({ IN_APP: true }));
vi.mock('./store', () => ({ toast: vi.fn(), selectNode: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), onAction: vi.fn() }));
const invoke = vi.fn();
const replies: ClientMessage[] = [];
const reply = (m: ClientMessage) => { replies.push(m); };
const offer = (sound = true): Extract<ServerMessage, { t: 'nativeNotify' }> => ({ t: 'nativeNotify', requestId: 'request', notification: { id: 'n1', title: 'Task', subtitle: 'Session', body: 'Finished', sound } });
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); replies.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  invoke.mockResolvedValue(undefined);
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(onAction).mockResolvedValue({ unregister: vi.fn() } as unknown as Awaited<ReturnType<typeof onAction>>);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('approved native notification UI', () => {
  it('never submits an OS notification from a raw notify event', async () => {
    const { handleNotify } = await import('./notify');
    handleNotify({ t: 'notify', id: 'n1', kind: 'done', title: 'Task' });
    expect(toast).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });
  it('advertises readiness after listener initialization and submits approved content with a receipt', async () => {
    const { initializeNativeNotifications, handleNativeNotification } = await import('./notify');
    await initializeNativeNotifications(reply);
    expect(invoke).not.toHaveBeenCalled();
    expect(replies).toEqual([{ t: 'nativeNotifyReady', ok: true }]);
    await handleNativeNotification(offer(), reply);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', { options: { title: 'Task', body: 'Session\nFinished', sound: 'NSUserNotificationDefaultSoundName', extra: { nodeId: 'n1' } } });
    expect(replies.at(-1)).toEqual({ t: 'nativeNotifyResult', requestId: 'request', ok: true });
  });
  it('does not advertise readiness when plugin initialization fails', async () => {
    vi.mocked(onAction).mockRejectedValueOnce(new Error('plugin unavailable'));
    const { initializeNativeNotifications } = await import('./notify');
    await initializeNativeNotifications(reply);
    expect(replies[0]).toMatchObject({ t: 'nativeNotifyReady', ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('requests permission when needed, reports denial, and never submits', async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue('denied');
    const { initializeNativeNotifications, handleNativeNotification } = await import('./notify');
    await initializeNativeNotifications(reply);
    await handleNativeNotification(offer(), reply);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(replies.at(-1)).toMatchObject({ t: 'nativeNotifyResult', ok: false });
    expect(invoke).not.toHaveBeenCalled();
  });
  it('reports plugin rejection and keeps banner-only notifications silent', async () => {
    const { initializeNativeNotifications, handleNativeNotification } = await import('./notify');
    await initializeNativeNotifications(reply);
    invoke.mockRejectedValueOnce(new Error('plugin unavailable'));
    await handleNativeNotification(offer(false), reply);
    expect(invoke.mock.calls[0][1].options).not.toHaveProperty('sound');
    expect(replies.at(-1)).toMatchObject({ t: 'nativeNotifyResult', ok: false, error: 'Error: plugin unavailable' });
  });
  it('selects the notification node and brings the native window forward on click', async () => {
    const { initializeNativeNotifications } = await import('./notify');
    await initializeNativeNotifications(reply);
    const callback = vi.mocked(onAction).mock.calls[0][0];
    callback({ actionId: 'tap', notification: { extra: { nodeId: 'n1' } } } as unknown as Parameters<typeof callback>[0]);
    await Promise.resolve(); await Promise.resolve();
    expect(selectNode).toHaveBeenCalledWith('n1');
    expect(invoke).toHaveBeenCalledWith('plugin:window|show', {});
    expect(invoke).toHaveBeenCalledWith('plugin:window|set_focus', {});
  });
});
