import { useState } from "react";
import { Setup } from "./pages/Setup.js";
import { Bot } from "./pages/Bot.js";
import { History } from "./pages/History.js";
import { Mock } from "./pages/Mock.js";
import { Conversations } from "./pages/Conversations.js";
import { Settings } from "./pages/Settings.js";

const PAGES = {
  setup: { label: "Setup", render: () => <Setup /> },
  bot: { label: "Connect bot", render: () => <Bot /> },
  history: { label: "Import history", render: () => <History /> },
  mock: { label: "Simulator", render: () => <Mock /> },
  conversations: { label: "Conversations", render: () => <Conversations /> },
  settings: { label: "Settings", render: () => <Settings /> },
} as const;

type PageKey = keyof typeof PAGES;

export function App(): JSX.Element {
  const [page, setPage] = useState<PageKey>("setup");

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>Nocheh</h1>
        {(Object.keys(PAGES) as PageKey[]).map((key) => (
          <button key={key} className={key === page ? "active" : ""} onClick={() => setPage(key)}>
            {PAGES[key].label}
          </button>
        ))}
      </nav>
      <main className="content">{PAGES[page].render()}</main>
    </div>
  );
}
