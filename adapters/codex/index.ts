// The real Codex TUI owns the terminal; the bridge observes and delivers through its app-server.
import { spawn, type ChildProcess } from 'node:child_process';
import { TillerClient, readToken } from '../shared/client.js';
import { CodexRpc } from './rpc.js';
import { CodexBridge, type BridgeOptions } from './bridge.js';
import { CodexTerminal } from './terminal.js';
import { ManagedChild } from './child.js';

let rpc: CodexRpc | undefined;
let client: TillerClient | undefined;
let bridge: CodexBridge | undefined;
let terminal: CodexTerminal | undefined;
let tui: ChildProcess | undefined;
let tuiProcess: ManagedChild | undefined;
let closing = false;
let diagnostics = '';
let backendError: Error | undefined;
async function close(error?: Error): Promise<void> {
  if (closing) return;
  closing = true;
  bridge?.beginShutdown();
  const tuiStopped = tuiProcess?.terminate();
  try { terminal?.close(); } catch (closeError) { error ??= closeError as Error; }
  let unconfirmed: Error | undefined;
  try { await rpc?.shutdown(); } catch (error) { unconfirmed = error as Error; }
  try { await bridge?.stop(); } catch { /* Daemon shutdown can close HTTP first. */ }
  client?.dispose();
  if (tuiStopped && !await tuiStopped) unconfirmed ??= new Error('Codex terminal exit was not confirmed after termination');
  if (unconfirmed) {
    console.error(`Error: ${unconfirmed.message}; keeping the host alive until managed children exit. Harness replacement must wait.`);
    // An unproven stop must not look like successful PTY termination to the daemon.
    // Keep a referenced handle even if the children have closed all of their stdio.
    const keepAlive = setInterval(() => {}, 1000);
    await Promise.all([tuiProcess?.exit, rpc?.processExit]);
    clearInterval(keepAlive);
    error ??= unconfirmed;
  }
  if (error) console.error(`Error: ${backendError ? diagnostics.trim() || backendError.message : error.message}`);
  process.exit(error ? 1 : 0);
}

try {
  const { TL_NODE_ID: nodeId, TL_ENDPOINT: endpoint, TL_TOKEN_FILE: tokenFile } = process.env;
  if (!nodeId || !endpoint || !tokenFile) throw new Error('Codex adapter requires Tiller node identity');
  const options = JSON.parse(process.argv[2]) as BridgeOptions;
  const token = await readToken(tokenFile);
  client = new TillerClient({ endpoint, nodeId, token });
  const fatal = (error: Error) => { void close(error); };
  // Keep backend diagnostics off the TUI's screen unless startup fails.
  rpc = new CodexRpc({ ...process.env, TL_CODEX_AUTHORIZATION: `Bearer ${token}` }, (text) => { diagnostics = (diagnostics + text).slice(-8192); });
  rpc.onClose = (error) => { backendError = error; fatal(error); };
  bridge = new CodexBridge(options, rpc, client, (text) => process.stderr.write(text), fatal);
  rpc.onPacket = (packet) => { bridge!.handle(packet); if (!closing) terminal?.forward(packet); };
  process.on('SIGTERM', () => { void close(); });
  process.on('SIGHUP', () => { void close(); });
  await bridge.start(endpoint, nodeId);
  if (closing) throw new Error('Codex startup interrupted');
  terminal = new CodexTerminal(rpc, bridge.initialization, bridge.nativeThreadId, () => bridge!.startPolling(), fatal,
    bridge.hasHistory ? undefined : bridge.startResult);
  await terminal.listen();
  if (closing) throw new Error('Codex startup interrupted');
  const args = ['--remote', `unix://${terminal.socketPath}`];
  if (options.model) args.push('--model', options.model);
  if (options.effort && bridge.freshThread) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`);
  if (bridge.hasHistory) args.push('resume', bridge.nativeThreadId);
  if (options.prompt) args.push('--', options.prompt);
  tui = spawn('codex', args, { env: process.env, stdio: 'inherit' });
  tuiProcess = new ManagedChild(tui);
  tui.on('error', fatal);
  tui.on('exit', (code) => { void close(code ? new Error(`Codex terminal exited (${code})`) : undefined); });
} catch (error) { await close(error as Error); }
