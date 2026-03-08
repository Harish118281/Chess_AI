const BASE_URL = 'http://127.0.0.1:8000';

export async function getAIMove(fen: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/ai-move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen }),
  });

  if (!res.ok) {
    throw new Error('Backend unavailable');
  }

  return res.json();
}

export async function notifyGameEnd(fen: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/game-end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen }),
  });

  if (!res.ok) {
    throw new Error('Backend unavailable');
  }
}

export async function stopTraining(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/play-button-clicked`, {
    method: 'POST',
  });

  if (!res.ok) {
    throw new Error('Backend unavailable');
  }
}

export async function getStatus(): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/status`);
  if (!res.ok) {
    throw new Error('Backend unavailable');
  }
  return res.json();
}

export async function resetAiMemory(key: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/admin/reset-ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      key,
    }),
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('UNAUTHORIZED');
    }
    throw new Error('RESET_FAILED');
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (record.status === 'error') {
      const message =
        typeof record.message === 'string' && record.message.trim().length > 0
          ? record.message
          : 'RESET_FAILED';
      throw new Error(message);
    }
  }
}

export { BASE_URL };
