import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DIRECT_SCOPE, OAuthManager, type SecretStore, type StateStore } from './oauth';
import { BridgeError } from './errors';
import { encryptSession, parseTransferJson, validateTransferRequest, WorkbenchTransfer } from './transfer';
import { needsRemoteSignIn } from './hosting';

export class WorkbenchSignIn {
  readonly remote: boolean;
  private transfer: WorkbenchTransfer;
  constructor(private context: vscode.ExtensionContext, private auth: OAuthManager,
    private beforeImport: () => void, private afterImport: () => Promise<unknown>) {
    this.remote = needsRemoteSignIn(vscode.env.uiKind === vscode.UIKind.Web, vscode.env.remoteName, context.extension.extensionKind === vscode.ExtensionKind.Workspace);
    this.transfer = new WorkbenchTransfer(context.secrets, context.globalStorageUri.fsPath);
  }
  async clear() { await this.transfer.clear(); }
  async clearExpired() { await this.transfer.clearExpired(); }
  async start() {
    const choice = await vscode.window.showInformationMessage('Workbench sign-in needs a one-time authorization on your PC.',
      { modal: true, detail: 'Prepare and download a sign-in request. Open it using this extension in local Positron, complete ChatGPT consent, then upload and import the encrypted session file here. Only this Workbench installation can decrypt it. Workbench will store and renew the session in its SecretStorage.' }, 'Prepare request', 'Import session');
    if (choice === 'Prepare request') return this.prepare();
    if (choice === 'Import session') return this.import();
  }
  async prepare() {
    const destination = await vscode.window.showSaveDialog({ title: 'Save Workbench request, then download it to your PC', defaultUri: vscode.Uri.file(join(homedir(), 'chatgpt-oauth-workbench-request.json')), filters: { JSON: ['json'] } });
    if (!destination) return;
    const request = await this.transfer.prepare(await this.auth.hostId());
    await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(request, null, 2) + '\n'));
    void vscode.window.showInformationMessage('Download the request file to your PC. In local Positron with this VSIX installed, run “ChatGPT OAuth: Authorize Workbench on This PC”. Requests expire after one hour.');
    return { prepared: true };
  }
  async authorize() {
    if (this.remote) throw new BridgeError(400, 'local_authorization_required', 'Run Authorize Workbench on This PC in local Positron Desktop, where the browser callback can reach its loopback listener.');
    const source = (await vscode.window.showOpenDialog({ title: 'Open the request downloaded from your Workbench session', canSelectMany: false, filters: { JSON: ['json'] } }))?.[0];
    if (!source) return;
    const request = validateTransferRequest(parseTransferJson(Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8')));
    const destination = await vscode.window.showSaveDialog({ title: 'Save encrypted session to upload to Workbench', defaultUri: vscode.Uri.file(join(homedir(), 'chatgpt-oauth-workbench-session.json')), filters: { JSON: ['json'] } });
    if (!destination) return;
    // Dedicated authorization for the server host; never export the desktop's
    // active session or share a rotating refresh token between two runtimes.
    const secretValues = new Map<string, string>(); const stateValues = new Map<string, any>([['hostId', request.hostId]]);
    const secrets: SecretStore = { get: async key => secretValues.get(key), store: async (key, value) => { secretValues.set(key, value); }, delete: async key => { secretValues.delete(key); } };
    const state: StateStore = { get: <T>(key: string, fallback: T) => stateValues.get(key) ?? fallback, update: async (key, value) => { stateValues.set(key, value); } };
    const helper = new OAuthManager(secrets, state, 'unused', { lock: async action => action() });
    let exported = false;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Authorize your Workbench ChatGPT connection in this PC’s browser', cancellable: true }, async (_, token) => {
        const controller = new AbortController(); const listener = token.onCancellationRequested(() => controller.abort());
        try {
          const session = await helper.signIn(url => vscode.env.openExternal(vscode.Uri.parse(url)), undefined, controller.signal);
          if (!session.scopes.includes(DIRECT_SCOPE)) throw new BridgeError(403, 'plan_permission_missing', 'ChatGPT plan use was not enabled. Authorize the Workbench request again and grant plan consent.');
          controller.signal.throwIfAborted();
          const encrypted = encryptSession(request, session);
          await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(encrypted, null, 2) + '\n'));
          exported = true;
        } finally { listener.dispose(); }
      });
      void vscode.window.showInformationMessage('Upload the encrypted session file to your Workbench session and run “ChatGPT OAuth: Import Workbench Sign-In”. Your local Positron sign-in was preserved. Delete both transfer files after successful import.');
      return { exported: true };
    } finally {
      if (!exported && await helper.active()) await helper.signOut(true);
      helper.dispose(); secretValues.clear(); stateValues.clear();
    }
  }
  async import() {
    const source = (await vscode.window.showOpenDialog({ title: 'Open the encrypted session uploaded from your PC', canSelectMany: false, filters: { JSON: ['json'] } }))?.[0];
    if (!source) return;
    const envelope = parseTransferJson(Buffer.from(await vscode.workspace.fs.readFile(source)).toString('utf8'));
    this.beforeImport();
    await this.transfer.consume(envelope, await this.auth.hostId(), session => this.auth.importSession(session));
    await this.afterImport();
    void vscode.window.showInformationMessage('Workbench sign-in imported. Workbench owns token renewal. Run “ChatGPT OAuth: Connect Posit Assistant”, then select a ChatGPT OAuth (local) model. Delete the two transfer files.');
    return { imported: true };
  }
}
