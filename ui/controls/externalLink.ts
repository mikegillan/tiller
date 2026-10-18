import type { TauriWindow } from '../hooks';

/** The native boundary also validates this; callers cannot open files or custom protocols. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP and HTTPS links can be opened');
  const tauri = (window as TauriWindow).__TAURI_INTERNALS__;
  if (!tauri) throw new Error('Native link opener unavailable');
  await tauri.invoke('open_external_url', { url });
}
