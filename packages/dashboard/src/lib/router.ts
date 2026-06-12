// A ~60-line hash router — deep links, browser back/forward, reload survival
// without a routing dependency. The dashboard is a single static page served by
// the control plane, so hash routes (`#/p/<id>`) work from any deployment with
// zero server configuration.

import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "project"; id: string }
  | { name: "settings"; tab?: string }
  | { name: "providers" }
  | { name: "add" };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const seg = path.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
  switch (seg[0]) {
    case "p":
      if (seg[1] !== undefined && seg[1].length > 0) return { name: "project", id: seg[1] };
      return { name: "home" };
    case "settings":
      return seg[1] !== undefined ? { name: "settings", tab: seg[1] } : { name: "settings" };
    case "providers":
      return { name: "providers" };
    case "add":
      return { name: "add" };
    default:
      return { name: "home" };
  }
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "project":
      return `#/p/${encodeURIComponent(route.id)}`;
    case "settings":
      return route.tab !== undefined ? `#/settings/${route.tab}` : "#/settings";
    case "providers":
      return "#/providers";
    case "add":
      return "#/add";
  }
}

export function useRoute(): { route: Route; navigate: (to: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((to: Route): void => {
    window.location.hash = routeHash(to);
  }, []);

  return { route, navigate };
}
