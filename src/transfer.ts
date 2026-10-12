import { createCipheriv, createDecipheriv, createPublicKey, generateKeyPair, privateDecrypt, publicEncrypt, randomBytes, randomUUID, constants } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { BridgeError } from './errors';
import { withFileLock, type SecretStore, type Session } from './oauth';

const APP = 'clickme1234.posit-assistant-chatgpt-oauth';
const PENDING = 'workbench.pending.v1';
const TTL = 60 * 60 * 1000;
export interface TransferRequest { app: typeof APP; version: 1; keyId: string; hostId: string; expiresAt: number; publicKey: string; }
interface PendingTransfer { request: TransferRequest; privateKey: string; }

const invalid = () => new BridgeError(400, 'invalid_workbench_transfer', 'The Workbench sign-in file is invalid, expired, changed, or belongs to another installation. Prepare a new request and authorize it on your PC.');
export function parseTransferJson(text: string): any {
  if (Buffer.byteLength(text) > 256 * 1024) throw invalid();
  try { return JSON.parse(text); } catch { throw invalid(); }
}
export function validateTransferRequest(value: any, now = Date.now()): TransferRequest {
  if (value?.app !== APP || value.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId ?? '') ||
    !/^[0-9a-f-]{36}$/i.test(value.keyId ?? '') || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + TTL + 60_000 ||
    typeof value.publicKey !== 'string' || value.publicKey.length > 4096) throw invalid();
  try {
    const key = createPublicKey(value.publicKey);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 3072) throw invalid();
  } catch { throw invalid(); }
  return { app: APP, version: 1, keyId: value.keyId, hostId: value.hostId, expiresAt: value.expiresAt, publicKey: value.publicKey };
}
const aad = (request: TransferRequest) => Buffer.from(JSON.stringify(request));
const decode = (value: any, length?: number) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256 * 1024) throw invalid();
  const data = Buffer.from(value, 'base64url');
  if (data.toString('base64url') !== value || (length !== undefined && data.length !== length)) throw invalid();
  return data;
};

export function encryptSession(requestValue: unknown, session: Session): any {
  const request = validateTransferRequest(requestValue);
  const key = randomBytes(32); const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(request));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: request.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, key);
    return { app: APP, version: 1, keyId: request.keyId, hostId: request.hostId, expiresAt: request.expiresAt,
      wrappedKey: wrappedKey.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  } finally { key.fill(0); }
}

export class WorkbenchTransfer {
  private lock: <T>(action: () => Promise<T>) => Promise<T>;
  constructor(private secrets: SecretStore, storageDirectory: string, lock?: <T>(action: () => Promise<T>) => Promise<T>) {
    this.lock = lock ?? (action => withFileLock(join(storageDirectory, 'workbench-transfer'), action));
  }
  async prepare(hostId: string): Promise<TransferRequest> {
    return this.lock(async () => {
      const keys = await promisify(generateKeyPair)('rsa', { modulusLength: 3072,
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      const request = validateTransferRequest({ app: APP, version: 1, hostId, keyId: randomUUID(), expiresAt: Date.now() + TTL, publicKey: keys.publicKey });
      await this.secrets.store(PENDING, JSON.stringify({ request, privateKey: keys.privateKey })); return request;
    });
  }
  async clear() { await this.lock(async () => { await this.secrets.delete(PENDING); }); }
  async clearExpired() {
    await this.lock(async () => {
      const pending = await this.secrets.get(PENDING); if (!pending) return;
      try { validateTransferRequest(parseTransferJson(pending).request); } catch { await this.secrets.delete(PENDING); }
    });
  }
  async consume(envelope: any, hostId: string, importer: (session: Session) => Promise<void>): Promise<void> {
    await this.lock(async () => {
      const saved = await this.secrets.get(PENDING); if (!saved) throw invalid();
      const pending = parseTransferJson(saved) as PendingTransfer;
      const request = validateTransferRequest(pending.request);
      if (hostId !== request.hostId || envelope?.app !== APP || envelope.version !== 1 || envelope.keyId !== request.keyId || envelope.hostId !== hostId || envelope.expiresAt !== request.expiresAt) throw invalid();
      let key: Buffer | undefined; let plaintext: Buffer | undefined; let session: Session;
      try {
        key = privateDecrypt({ key: pending.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, decode(envelope.wrappedKey, 384));
        if (key.length !== 32) throw invalid();
        const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
        decipher.setAAD(aad(request)); decipher.setAuthTag(decode(envelope.tag, 16));
        plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
        session = parseTransferJson(plaintext.toString('utf8')) as Session;
      } catch { throw invalid(); }
      finally { key?.fill(0); plaintext?.fill(0); }
      // The importer verifies the ID token and identity before saving credentials.
      // Consume the one-time private key only after that succeeds.
      await importer(session);
      await this.secrets.delete(PENDING);
    });
  }
}
