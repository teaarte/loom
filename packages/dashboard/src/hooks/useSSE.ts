import { useEffect, useRef, useState } from "react";

import { sseUrl } from "../lib/api.js";
import type { LogSnapshot } from "../lib/types.js";

export interface SSEState {
  // The most recent snapshot, or null before the first tick arrives.
  snapshot: LogSnapshot | null;
  // open while the EventSource is connected; false after it errors/closes.
  connected: boolean;
}

// Subscribe to a project's live log stream (`GET /projects/:id/log`), an
// EventSource over the preserved `?token=` SSE contract (an EventSource cannot
// set the Authorization header). Each message is `data: { status, log }`; we
// keep only the latest snapshot — the server already tails a bounded window, so
// there is nothing to accumulate client-side. The connection closes on unmount
// or when `path` changes (drilling into another project), and reports `connected`
// so the view can show a "stream closed" state, mirroring the prior console.
export function useSSE(path: string | null): SSEState {
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  // Guard so a late message from a closed/replaced stream can't update state.
  const live = useRef(0);

  useEffect(() => {
    setSnapshot(null);
    setConnected(false);
    if (path === null) return;

    const mine = ++live.current;
    const es = new EventSource(sseUrl(path));
    es.onopen = () => {
      if (mine === live.current) setConnected(true);
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      if (mine !== live.current) return;
      try {
        setSnapshot(JSON.parse(ev.data) as LogSnapshot);
      } catch {
        /* a malformed frame skips one tick */
      }
    };
    es.onerror = () => {
      if (mine === live.current) setConnected(false);
      // The browser auto-reconnects an EventSource; `connected` flips back on
      // the next `onopen`. We do not close here so a transient blip recovers.
    };

    return () => {
      live.current++;
      es.close();
    };
  }, [path]);

  return { snapshot, connected };
}
