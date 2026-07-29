const PREVIEW_TOKEN_TTL_SECONDS = 5 * 60;
const encoder = new TextEncoder();

function previewMessage(
  runtimeUserId: string,
  sessionId: string,
  expiresAt: number
): string {
  return `preview:v1\0${runtimeUserId}\0${sessionId}\0${expiresAt}`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function signedPreviewUrl({
  runtimeBaseUrl,
  runtimeUserId,
  sessionId,
  secret,
  now = Date.now(),
}: {
  runtimeBaseUrl: string;
  runtimeUserId: string;
  sessionId: string;
  secret: string;
  now?: number;
}): Promise<{ url: string; expiresAt: number }> {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) {
    throw new Error('Runtime preview signing is not configured');
  }
  const expiresAt = Math.floor(now / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalizedSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(previewMessage(runtimeUserId, sessionId, expiresAt))
  );
  const token = `${expiresAt}.${encodeBase64Url(new Uint8Array(signature))}`;
  const base = runtimeBaseUrl.replace(/\/+$/, '');
  return {
    url: `${base}/preview/${encodeURIComponent(runtimeUserId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(token)}/`,
    expiresAt,
  };
}
