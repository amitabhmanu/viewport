import { useEffect, useState } from "react";
import { subscribe } from "./api.js";
import { AskPage } from "./AskPage.js";
import { LedgerPage } from "./LedgerPage.js";
import { LiveContext } from "./live.js";
import { MapPage } from "./MapPage.js";
import { useRoute } from "./router.js";
import { TodayPage } from "./TodayPage.js";

const TABS = [
  ["/", "Today"],
  ["/map", "Map"],
  ["/ledger", "Ledger"],
  ["/ask", "Ask"],
] as const;

export function App() {
  const [route, go] = useRoute();
  const [live, setLive] = useState({ model: 0, ledger: 0, state: 0 });
  const [connected, setConnected] = useState(true);

  useEffect(
    () =>
      subscribe(
        (changed) =>
          setLive((v) => ({
            model: v.model + (changed.includes("model") ? 1 : 0),
            ledger: v.ledger + (changed.includes("ledger") ? 1 : 0),
            state: v.state + (changed.includes("state") ? 1 : 0),
          })),
        setConnected,
      ),
    [],
  );

  const tab = TABS.find(([path]) => (path === "/" ? route.path === "/" : route.path.startsWith(path)))?.[0] ?? "/";
  return (
    <LiveContext.Provider value={live}>
      <header className="top">
        <span className="brand">Viewport</span>
        <nav>
          {TABS.map(([path, label]) => (
            <a
              key={path}
              href={path}
              aria-current={tab === path ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(path);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <span className={`live ${connected ? "on" : "off"}`} title={connected ? "Updates as the model changes" : "Reconnecting to the daemon"}>
          {connected ? "Live" : "Offline"}
        </span>
      </header>
      <main>
        {tab === "/" && <TodayPage go={go} />}
        {tab === "/map" && <MapPage params={route.params} go={go} />}
        {tab === "/ledger" && <LedgerPage />}
        {tab === "/ask" && <AskPage params={route.params} go={go} />}
      </main>
    </LiveContext.Provider>
  );
}
