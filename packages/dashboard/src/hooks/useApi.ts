import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "../lib/api.js";

export interface ApiState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
}

// A tiny GET hook over the preserved `api()` contract: fetch on mount, re-fetch
// on an optional interval, and expose a manual `reload`. No external data
// library — a localhost console doesn't need a cache layer; this keeps the wire
// contract transparent. The token is read per-request inside `api()`, so saving
// a token and calling `reload` re-authenticates without re-mounting.
export function useApi<T>(path: string, intervalMs?: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  // A monotonically increasing token so a slow in-flight response from a stale
  // path/interval never overwrites a newer one.
  const gen = useRef(0);

  const run = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    try {
      const result = await api<T>("GET", path);
      if (mine === gen.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mine === gen.current) setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void run();
    if (intervalMs === undefined || intervalMs <= 0) return;
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
  }, [run, intervalMs]);

  return { data, error, loading, reload: () => void run() };
}
