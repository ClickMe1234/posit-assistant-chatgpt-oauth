// Manual/live verification inside the user's installed Positron extension host.
// No credentials or prompts are written to probe output. OpenAI is not mocked.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const directory = path.join(__dirname, '..', '.live');
const safeFailure = error => ({ code: error?.code ?? 'live_probe_failure', status: error?.status, name: error?.name, message: String(error?.message ?? 'Live host probe failed').replace(/https?:\/\/\S+/g, '[URL redacted]').replace(/(Bearer\s+|(?:access|refresh|id)_token[=:]\s*)[^\s,]+/gi, '$1[redacted]').slice(0, 400) });
exports.run = async function (injectedApi) {
  await fs.mkdir(directory, { recursive: true });
  const write = async value => fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(value, null, 2));
  let stage = 'activating'; let api;
  try {
    await write({ stage, live: true });
    api = injectedApi ?? await vscode.extensions.getExtension('clickme1234.posit-assistant-chatgpt-oauth').activate();
    stage = 'browser-sign-in'; await write({ stage, live: true, status: await api.status() });
    if (!(await api.status()).signedIn) await api.signIn();
    stage = 'model-discovery'; await write({ stage, live: true, status: await api.status() });
    const models = await api.discoverModels();
    await fs.writeFile(path.join(directory, 'models.json'), JSON.stringify(models.map(model => ({ slug: model.slug, displayName: model.display_name })), null, 2));
    stage = 'subscription-stream'; await write({ stage, live: true, models: models.map(model => ({ slug: model.slug, displayName: model.display_name })) });
    const first = await api.verifyStream(models[0].slug);
    await fs.writeFile(path.join(directory, 'stream.json'), JSON.stringify(first, null, 2));
    stage = 'assistant-connection'; await write({ stage, live: true, first });
    const connection = await api.connectAssistant();
    await fs.writeFile(path.join(directory, 'connection.json'), JSON.stringify(connection, null, 2));
    await vscode.commands.executeCommand('posit-assistant.open');
    stage = 'assistant-ready'; await write({ stage, live: true, first, connection, status: await api.status() });
    // A bounded manual control queue allows the user to select the account model
    // in Assistant before its existing newChat command submits verification prompts.
    let lastId;
    for (let n = 0; n < 1800; n++) {
      await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify(await api.status(), null, 2));
      let control;
      try { control = JSON.parse(await fs.readFile(path.join(directory, 'control.json'), 'utf8')); } catch {}
      if (control && control.id !== lastId) {
        lastId = control.id;
        let result;
        try {
          if (control.action === 'submit') result = await vscode.commands.executeCommand('posit-assistant.newChat', { prompt: control.prompt, target: control.target ?? 'auto', behavior: 'submit' });
          else if (control.action === 'disconnect') result = await api.disconnectAssistant();
          else if (control.action === 'sign-out') result = await api.signOut();
          else if (control.action === 'renew') result = await api.renewSession();
          else if (control.action === 'sign-in') result = await api.signIn();
          else if (control.action === 'connect') result = await api.connectAssistant();
          else if (control.action === 'verify') result = await api.verifyStream(control.model);
          else if (control.action === 'done') break;
          else throw new Error('Unsupported live probe action');
          await fs.writeFile(path.join(directory, 'control-result.json'), JSON.stringify({ id: control.id, ok: true, result }, null, 2));
        } catch (error) { await fs.writeFile(path.join(directory, 'control-result.json'), JSON.stringify({ id: control.id, ok: false, error: safeFailure(error) }, null, 2)); }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await write({ stage: 'finished', live: true, first, connection, status: await api.status() });
  } catch (error) {
    await write({ stage, live: true, error: safeFailure(error), status: api ? await api.status() : undefined });
    throw new Error('Live ChatGPT Plan probe stopped; see .live/result.json.');
  }
};
