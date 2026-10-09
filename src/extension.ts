import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OAuthManager, DIRECT_SCOPE, type Registration } from './oauth';
import { OAuthBridge } from './bridge';
import { BridgeError, safeError } from './errors';
import { backupConfig, PROVIDER_NAME, readConfig, updateOwnedProvider } from './config';
import { UsageIndicator, showWelcomeOnce } from './usage';

const USAGE = 'https://chatgpt.com/#settings/Usage';
const BRIDGE_SECRET = 'bridge.credential.v1';
const PROVIDER_METADATA_VERSION = 1;
let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ChatGPT OAuth');
  const usage = new UsageIndicator();
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  const auth = new OAuthManager(context.secrets, context.globalState, context.globalStorageUri.fsPath);
  const configPath = join(homedir(), '.posit', 'ai', 'providers.json');
  const port = vscode.workspace.getConfiguration('chatgptOAuth').get<number>('port', 17864);
  let bridge: OAuthBridge | undefined;
  let disposed = false;
  let lastError: string | undefined;
  const updateBar = async () => {
    const active = await auth.active();
    const presentation = usage.presentation(Boolean(active), active?.scopes.includes(DIRECT_SCOPE) ?? false);
    bar.text = presentation.text; bar.command = presentation.command; bar.tooltip = presentation.tooltip; bar.show();
  };
  const ensureBridge = async () => {
    if (disposed) throw new BridgeError(503, 'extension_stopped', 'The extension is stopping.');
    if (bridge) return bridge;
    let credential = await context.secrets.get(BRIDGE_SECRET);
    if (!credential) { credential = randomBytes(32).toString('base64url'); await context.secrets.store(BRIDGE_SECRET, credential); }
    const candidate = new OAuthBridge(auth, credential, port, fetch, receipt => {
      output.appendLine(`Request: ${JSON.stringify(receipt)}`);
      if (receipt.upstreamStatus === 429 || receipt.errorCode?.includes('usage_limit')) {
        void vscode.window.showWarningMessage('ChatGPT usage limit reached. Review your plan or this app’s limit in ChatGPT settings.', { modal: true }, 'Manage usage').then(action => { if (action === 'Manage usage') void vscode.env.openExternal(vscode.Uri.parse(USAGE)); });
      }
    }, (receipt, active) => { usage.setActive(receipt, active); void updateBar(); });
    try { await candidate.start(); }
    catch { await candidate.stop(); throw new BridgeError(503, 'port_unavailable', `Loopback port ${port} is unavailable. Close other Positron windows using this bridge or change ChatGPT OAuth: Port and reload.`); }
    bridge = candidate; return candidate;
  };
  const discover = async () => {
    const activeBridge = await ensureBridge();
    const models = await activeBridge.models(undefined, true);
    output.appendLine(`Discovered ${models.length} account-specific models: ${models.map(model => model.slug).join(', ')}`);
    return models;
  };
  const signIn = async () => {
    const choices = auth.registrations(); let registration: Registration | undefined;
    if (choices.length) {
      const picked = await vscode.window.showQuickPick([
        ...choices.map(value => ({ label: value.email ?? 'Saved ChatGPT account', description: value.clientId.slice(-12), registration: value })),
        { label: 'Add another account or workspace', description: 'Register with ChatGPT', registration: undefined }
      ], { title: 'Continue with ChatGPT', placeHolder: 'Select a saved registration or add an account' });
      if (!picked) return;
      registration = picked.registration;
    }
    bridge?.cancelAll();
    const session = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Complete sign-in and plan consent in your browser', cancellable: true }, async (_, token) => {
      const controller = new AbortController(); const listener = token.onCancellationRequested(() => controller.abort());
      try { return await auth.signIn(url => vscode.env.openExternal(vscode.Uri.parse(url)), registration, controller.signal); }
      finally { listener.dispose(); }
    });
    await updateBar();
    if (!session.scopes.includes(DIRECT_SCOPE)) throw new BridgeError(403, 'plan_permission_missing', 'Signed in, but ChatGPT plan use was not enabled. Continue with ChatGPT again to request consent.');
    await showWelcomeOnce(context.globalState, async () => {
      const action = await vscode.window.showInformationMessage('You’re using your ChatGPT plan', { modal: true, detail: 'Eligible requests through ChatGPT OAuth use your ChatGPT plan or credits balance. Plan and app limits apply. Select ChatGPT OAuth (local) in Posit Assistant to use this connection. Manage usage in ChatGPT settings.' }, 'Got it', 'Manage usage');
      return action === 'Manage usage' ? 'usage' : undefined;
    }, () => vscode.env.openExternal(vscode.Uri.parse(USAGE)));
    const models = await discover();
    return { account: session.email ?? 'ChatGPT account', models: models.map(model => ({ slug: model.slug, displayName: model.display_name })) };
  };
  const verifyStream = async (selectedModel?: string) => {
    const activeBridge = await ensureBridge(); const models = await activeBridge.models();
    const model = selectedModel ?? (await vscode.window.showQuickPick(models.map(item => ({ label: item.display_name, description: item.slug, slug: item.slug })), { title: 'Verify a live subscription stream' }))?.slug;
    if (!model) return;
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Verifying live ChatGPT plan inference', cancellable: true }, async (_, token) => {
      const controller = new AbortController(); const listener = token.onCancellationRequested(() => controller.abort()); let text = '';
      try {
        for await (const event of activeBridge.stream({ model, input: [{ role: 'user', content: 'Say exactly: Hello, world!' }] }, controller.signal)) if (event.type === 'response.output_text.delta') text += event.delta;
        output.appendLine(`Live subscription stream completed with ${text.length} output characters for ${model}.`);
        void vscode.window.showInformationMessage(`Live subscription response completed: ${text}`);
        return { model, completed: true, text };
      } finally { listener.dispose(); }
    });
  };
  const authExtension = async () => {
    const extension = vscode.extensions.getExtension('positron.authentication');
    if (!extension) throw new BridgeError(501, 'positron_required', 'This prototype requires Positron with the bundled authentication extension.');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes('authentication.addCustomProvider') || !commands.includes('authentication.removeCustomProvider')) throw new BridgeError(501, 'provider_api_unavailable', 'This Positron release lacks the add/remove custom-provider command contract. See the feasibility report.');
  };
  const connectAssistant = async () => {
    await authExtension(); const activeBridge = await ensureBridge(); const models = await discover();
    const config = await readConfig(configPath); const existing = config.value.providers?.custom?.[PROVIDER_NAME];
    if (existing && (!context.globalState.get('ownsProvider', false) || existing.type !== 'openai' || existing.baseUrl !== activeBridge.baseUrl)) throw new BridgeError(409, 'provider_name_conflict', `An unrelated provider named ${PROVIDER_NAME} exists. It was preserved.`);
    const backup = await backupConfig(configPath, context.globalStorageUri.fsPath);
    await context.globalState.update('lastProviderBackup', backup);
    if (existing) await vscode.commands.executeCommand('authentication.removeCustomProvider', { name: PROVIDER_NAME });
    await vscode.commands.executeCommand('authentication.addCustomProvider', { name: PROVIDER_NAME, kind: 'openai', baseUrl: activeBridge.baseUrl, apiKey: await context.secrets.get(BRIDGE_SECRET), modelIds: models.map(model => model.slug) });
    await context.globalState.update('ownsProvider', true);
    await updateOwnedProvider(configPath, activeBridge.baseUrl, models);
    await context.globalState.update('providerMetadataVersion', PROVIDER_METADATA_VERSION);
    output.appendLine(`Assistant provider connected. Configuration backup: ${backup}`);
    void vscode.window.showInformationMessage(`Select ${PROVIDER_NAME} in Posit Assistant’s model picker to use your ChatGPT plan.`, 'Open Assistant').then(action => { if (action) void vscode.commands.executeCommand('posit-assistant.open'); });
    return { provider: PROVIDER_NAME, baseUrl: activeBridge.baseUrl, backup, models: models.map(model => model.slug) };
  };
  const disconnectAssistant = async () => {
    if (!context.globalState.get('ownsProvider', false)) return { removed: false };
    const { value } = await readConfig(configPath);
    const entry = value.providers?.custom?.[PROVIDER_NAME];
    if (entry) {
      if (entry.type !== 'openai' || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(entry.baseUrl ?? '')) throw new BridgeError(409, 'provider_changed', 'The owned provider was replaced with another endpoint. It was preserved; remove its saved local credential through Positron’s provider dialog.');
      await authExtension();
      await backupConfig(configPath, context.globalStorageUri.fsPath);
      await vscode.commands.executeCommand('authentication.removeCustomProvider', { name: PROVIDER_NAME });
    }
    await context.globalState.update('ownsProvider', false);
    return { removed: true };
  };
  const signOut = async () => {
    bridge?.cancelAll();
    let cleanupError: unknown;
    try { await disconnectAssistant(); } catch (error) { cleanupError = error; }
    const confirmed = await auth.signOut(true);
    await bridge?.stop(); bridge = undefined;
    await context.secrets.delete(BRIDGE_SECRET); await updateBar();
    if (!confirmed) void vscode.window.showWarningMessage('Local tokens were removed. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.');
    if (cleanupError) throw cleanupError;
    void vscode.window.showInformationMessage('Signed out. Local credentials and the Assistant provider were removed.');
    return { signedOut: true, remoteRevocationConfirmed: confirmed };
  };
  const status = async () => {
    const session = await auth.active();
    return { signedIn: Boolean(session), planPermission: session?.scopes.includes(DIRECT_SCOPE) ?? false,
      account: session?.email, registration: session?.clientId, expiresAt: session?.expiresAt ? new Date(session.expiresAt).toISOString() : undefined,
      runtime: process.platform, architecture: process.arch, remoteName: vscode.env.remoteName ?? null,
      appName: vscode.env.appName, vscodeVersion: vscode.version, assistantVersion: vscode.extensions.getExtension('posit.assistant')?.packageJSON.version,
      credentialStorage: { oauthPresent: Boolean(await context.secrets.get('oauth.sessions.v1')), bridgePresent: Boolean(await context.secrets.get(BRIDGE_SECRET)) },
      bridge: bridge?.baseUrl ?? null, providerConfigured: context.globalState.get('ownsProvider', false),
      lastProviderBackup: context.globalState.get('lastProviderBackup', undefined), lastError, receipts: bridge?.receipts.map(item => ({ ...item })) ?? [], usageUrl: USAGE };
  };
  const handleError = async (error: unknown) => {
    const safe = safeError(error); lastError = `${safe.code}: ${safe.message}`;
    output.appendLine(lastError + (safe.requestId ? ` (request ${safe.requestId})` : ''));
    await updateBar();
    if (safe.status === 499) return;
    const action = await vscode.window.showErrorMessage(safe.message, ...(safe.status === 429 ? ['Manage usage'] : []));
    if (action === 'Manage usage') await vscode.env.openExternal(vscode.Uri.parse(USAGE));
  };
  const command = (name: string, action: (...args: any[]) => Promise<any>) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => { try { return await action(...args); } catch (error) { await handleError(error); return undefined; } }));
  command('chatgptOAuth.signIn', signIn); command('chatgptOAuth.signOut', signOut);
  command('chatgptOAuth.models', async () => { const models = await discover(); await vscode.window.showQuickPick(models.map(item => ({ label: item.display_name, description: item.slug })), { title: 'Models from your ChatGPT account' }); return models; });
  command('chatgptOAuth.verifyStream', verifyStream); command('chatgptOAuth.connectAssistant', connectAssistant); command('chatgptOAuth.disconnectAssistant', disconnectAssistant);
  command('chatgptOAuth.status', async () => { output.appendLine(JSON.stringify(await status(), null, 2)); output.show(); const action = await vscode.window.showInformationMessage('ChatGPT Plan connection details are in the output panel.', 'Manage usage'); if (action) await vscode.env.openExternal(vscode.Uri.parse(USAGE)); });
  command('chatgptOAuth.manageUsage', async () => vscode.env.openExternal(vscode.Uri.parse(USAGE)));
  context.subscriptions.push(output, bar, { dispose: () => { disposed = true; auth.dispose(); void bridge?.stop(); } }, context.secrets.onDidChange(event => { if (event.key === 'oauth.sessions.v1') void updateBar(); }));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: async uri => { const action = ({ '/sign-in': 'chatgptOAuth.signIn', '/status': 'chatgptOAuth.status', '/connect': 'chatgptOAuth.connectAssistant' } as Record<string, string>)[uri.path]; if (action && !uri.query) await vscode.commands.executeCommand(action); } }));
  shutdown = async () => { disposed = true; auth.dispose(); await bridge?.stop(); };
  await updateBar();
  if (await auth.active()) {
    try {
      const activeBridge = await ensureBridge();
      if (context.globalState.get('ownsProvider', false) && context.globalState.get('providerMetadataVersion', 0) < PROVIDER_METADATA_VERSION) {
        const { value } = await readConfig(configPath);
        const entry = value.providers?.custom?.[PROVIDER_NAME];
        if (entry) {
          if (entry.type !== 'openai' || entry.baseUrl !== activeBridge.baseUrl) throw new BridgeError(409, 'provider_changed', 'The provider endpoint changed. Reconnect ChatGPT OAuth to update image support.');
          const models = await activeBridge.models();
          const backup = await backupConfig(configPath, context.globalStorageUri.fsPath);
          await context.globalState.update('lastProviderBackup', backup);
          await updateOwnedProvider(configPath, activeBridge.baseUrl, models, false);
          await context.globalState.update('providerMetadataVersion', PROVIDER_METADATA_VERSION);
          output.appendLine('Updated the owned Assistant provider with image and plot capabilities; previous configuration was backed up.');
          void vscode.window.showInformationMessage('ChatGPT OAuth image support is enabled. Start a new Assistant chat to use the updated model capabilities.');
        }
      }
    } catch (error) { await handleError(error); }
  }
  // A small testable control API; it never exports tokens or local credentials.
  return { status, signIn, discoverModels: discover, verifyStream, connectAssistant, disconnectAssistant, signOut,
    renewSession: async () => { await auth.accessToken(true); return { renewed: true, expiresAt: new Date((await auth.active())!.expiresAt).toISOString() }; } };
}

export async function deactivate() { await shutdown?.(); }
