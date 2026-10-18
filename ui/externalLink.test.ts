import { afterEach, expect, it, vi } from 'vitest';
import { openExternalUrl } from './externalLink';

afterEach(() => vi.unstubAllGlobals());

it('invokes only the narrow native web opener with the original URL', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  await openExternalUrl('https://github.com/example/tiller?a=1&b=2');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('open_external_url', { url: 'https://github.com/example/tiller?a=1&b=2' });
});

it.each(['javascript:alert(1)', 'file:///tmp/file', 'mailto:a@example.com', '/tmp/file', '//example.com'])('rejects non-web targets before native invocation: %s', async (url) => {
  const invoke = vi.fn();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  await expect(openExternalUrl(url)).rejects.toThrow('Only HTTP and HTTPS');
  expect(invoke).not.toHaveBeenCalled();
});

it('propagates native failure and unavailable bridges for the UI to recover', async () => {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: vi.fn().mockRejectedValue(new Error('No browser')) } });
  await expect(openExternalUrl('https://example.com')).rejects.toThrow('No browser');
  vi.stubGlobal('window', {});
  await expect(openExternalUrl('https://example.com')).rejects.toThrow('unavailable');
});
