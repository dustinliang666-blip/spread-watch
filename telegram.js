import http from 'node:http';
import https from 'node:https';

export function telegramConfigured(token, chatId) {
  return typeof token === 'string' && /^\d{5,16}:[\w-]{20,}$/.test(token) &&
    typeof chatId === 'string' && /^-?[1-9]\d{0,18}$/.test(chatId);
}

export function createTelegramSender({ token, chatId, testOrigin, timeoutMs = 5_000 }) {
  const origin = testOrigin === undefined ? new URL('https://api.telegram.org') : new URL(testOrigin);
  if (testOrigin !== undefined && (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1')) {
    throw new Error('Test transport must use loopback HTTP');
  }
  if (!telegramConfigured(token, chatId)) throw new Error('Telegram configuration is incomplete');
  const path = `/bot${token}/sendMessage`;
  const transport = origin.protocol === 'https:' ? https : http;

  return async function send(text) {
    try {
      const body = JSON.stringify({ chat_id: chatId, text });
      const status = await new Promise((resolve, reject) => {
        const request = transport.request(origin, {
          method: 'POST', path, agent: false, signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, async (response) => {
          try {
            const chunks = [];
            let bytes = 0;
            for await (const chunk of response) {
              bytes += chunk.length;
              if (bytes > 32_768) throw new Error('Response too large');
              chunks.push(chunk);
            }
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const httpStatus = response.statusCode;
            const success = httpStatus >= 200 && httpStatus < 300;
            const messageId = result?.result?.message_id;
            if (success && result?.ok === true && Number.isSafeInteger(messageId) && messageId > 0) {
              resolve({ delivery: 'SENT', receiptId: messageId });
            } else if ((success || (httpStatus >= 400 && httpStatus < 500)) && result?.ok === false) {
              resolve({ delivery: 'FAILED' });
            } else {
              resolve({ delivery: 'DELIVERY UNKNOWN' });
            }
          } catch (error) {
            reject(error);
          }
        });
        request.on('error', reject);
        request.end(body);
      });
      return status;
    } catch {
      return { delivery: 'DELIVERY UNKNOWN' };
    }
  };
}
