import type { PushNotifier } from '@civicmerge/contracts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushNotifierOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
}

export function createExpoPushNotifier(options: ExpoPushNotifierOptions = {}): PushNotifier {
  const fetcher = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const endpoint = options.endpoint ?? EXPO_PUSH_URL;

  return {
    async notifyStatusChange(input) {
      const validTokens = [...new Set(input.tokens.map(token => token.trim()).filter(Boolean))];
      if (validTokens.length === 0) return;

      const messages = validTokens.map(to => ({
        to,
        sound: 'default',
        title: input.title,
        body: input.body,
        data: {
          incidentId: input.incidentId,
          status: input.status,
        },
      }));

      try {
        await fetcher(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify(messages),
        });
      } catch {
        // Push notifications are best-effort and must never fail a committed status update.
      }
    },
  };
}
