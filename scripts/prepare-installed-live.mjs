import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('.live/installed-driver', { recursive: true });
await writeFile('.live/installed-driver/package.json', JSON.stringify({
  name: 'positron-plan-verification-driver', publisher: 'local-prototypes', version: '0.0.0',
  displayName: 'Installed ChatGPT Plan Verification', engines: { vscode: '^1.100.0' },
  main: './extension.cjs', extensionKind: ['ui'], activationEvents: ['onStartupFinished'],
  extensionDependencies: ['clickme1234.posit-assistant-chatgpt-oauth']
}, null, 2));
await writeFile('.live/installed-driver/extension.cjs', `
const vscode = require('vscode');
const fs = require('node:fs/promises');
exports.activate = async () => {
  const extension = vscode.extensions.getExtension('clickme1234.posit-assistant-chatgpt-oauth');
  await fs.writeFile(require('node:path').join(__dirname, '..', 'installed-runtime.json'), JSON.stringify({ extensionPath: extension.extensionPath, version: extension.packageJSON.version }, null, 2));
  void require('../../test/live-host.cjs').run().catch(() => {});
};
`);
