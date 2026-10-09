import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('.live/dev-extension', { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
manifest.main = './extension.cjs';
await writeFile('.live/dev-extension/package.json', JSON.stringify(manifest, null, 2));
await writeFile('.live/dev-extension/extension.cjs', `const main = require('../../dist/extension.cjs');
exports.activate = async context => {
  const api = await main.activate(context);
  void require('../../test/live-host.cjs').run(api).catch(() => {});
  return api;
};
exports.deactivate = main.deactivate;
`);
