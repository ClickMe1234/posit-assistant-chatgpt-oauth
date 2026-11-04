import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { PlanWindows } from './plan-usage';

export function readCodexQuota(): Promise<PlanWindows> {
  return new Promise((resolve, reject) => {
    const options = { cwd: homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] as const };
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/c', 'codex', 'app-server'], { ...options, stdio: [...options.stdio] })
      : spawn('codex', ['app-server'], { ...options, stdio: [...options.stdio] });
    const lines = createInterface({ input: child.stdout! });
    const send = (message: object) => child.stdin!.write(JSON.stringify(message) + '\n');
    let finished = false;
    const finish = (windows?: PlanWindows) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin!.end();
      if (windows) resolve(windows);
      else reject(new Error('Codex quota lookup failed. Install the Codex CLI on this host and sign in to Codex with ChatGPT.'));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish();
    }, 15_000);
    child.once('error', () => finish());
    child.once('exit', () => finish());
    child.stdin!.on('error', () => finish());
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id === 1 && message.result) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (message?.id === 2) {
        const bucket = message.result?.rateLimitsByLimitId?.codex ?? message.result?.rateLimits;
        const windows: PlanWindows = {};
        for (const reading of [bucket?.primary, bucket?.secondary]) {
          const window = reading?.windowDurationMins === 300 ? '5h' : reading?.windowDurationMins === 10080 ? '7d' : undefined;
          const usedPercent = reading?.usedPercent;
          if (!window || typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
          windows[window] = {
            usedPercent,
            remainingPercent: 100 - usedPercent,
            observedAt: new Date().toISOString(),
            resetsAt: Number.isSafeInteger(reading.resetsAt) && reading.resetsAt > 0 && reading.resetsAt <= 8.64e12 ? reading.resetsAt : undefined,
          };
        }
        finish(Object.keys(windows).length ? windows : undefined);
      } else if (message?.id === 1) finish();
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'posit_assistant_chatgpt_oauth', version: '0.5.1' } } });
  });
}
