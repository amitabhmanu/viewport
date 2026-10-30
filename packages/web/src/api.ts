import type { ChangesSince, Decision, Flag, Level, Model, NodeDetail, SplitView } from "@viewport/core";

/** The daemon's token arrives once in the URL; keep it for this tab and drop it from the address bar. */
function readToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem("viewport-token", fromUrl);
    } catch {
      // Storage can be unavailable; the token still works for this page load.
    }
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem("viewport-token") ?? "";
  } catch {
    return "";
  }
}

export const token = readToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export const api = {
  model: () => call<Model>("/api/model"),
  node: (id: string) => call<NodeDetail>(`/api/node?${q({ id })}`),
  view: (name: string, level: Level) => call<SplitView[]>(`/api/view?${q({ name, level })}`),
  ledger: () => call<Decision[]>("/api/ledger"),
  flags: () => call<Flag[]>("/api/flags"),
  changes: () => call<ChangesSince>("/api/changes"),
  seen: (subjects: string[]) => call<{ ok: true }>("/api/seen", { method: "POST", body: JSON.stringify({ subjects }) }),
  seenAll: () => call<{ ok: true }>("/api/seen", { method: "POST", body: JSON.stringify({ all: true }) }),
  flag: (subject: string, text: string) => call<Flag>("/api/flags", { method: "POST", body: JSON.stringify({ subject, text }) }),
};

/** Calls `onChange` with what changed whenever the daemon reports a change in .viewport/. */
export function subscribe(onChange: (changed: string[]) => void, onStatus: (connected: boolean) => void = () => {}): () => void {
  const source = new EventSource(`/api/events?${q({ token })}`);
  source.addEventListener("open", () => onStatus(true));
  source.addEventListener("error", () => onStatus(false));
  source.addEventListener("change", (e) => {
    const { changed } = JSON.parse((e as MessageEvent<string>).data) as { changed: string[] };
    onChange(changed);
  });
  return () => source.close();
}
