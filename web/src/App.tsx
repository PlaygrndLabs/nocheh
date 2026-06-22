import { useState } from "react";
import {
  Bot as BotIcon,
  FlaskConical,
  GitBranch,
  MessagesSquare,
  Settings as SettingsIcon,
  Sparkles,
  Upload,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Setup } from "./pages/Setup.js";
import { Bot } from "./pages/Bot.js";
import { History } from "./pages/History.js";
import { Simulator } from "./pages/Simulator.js";
import { Conversations } from "./pages/Conversations.js";
import { Knowledge } from "./pages/Knowledge.js";
import { Settings } from "./pages/Settings.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import { useTheme } from "./theme.js";

const PAGES = {
  setup: { label: "Setup", render: () => <Setup /> },
  bot: { label: "Connect bot", render: () => <Bot /> },
  history: { label: "Import history", render: () => <History /> },
  mock: { label: "Simulator", render: () => <Simulator /> },
  conversations: { label: "Conversations", render: () => <Conversations /> },
  knowledge: { label: "Knowledge graph", render: () => <Knowledge /> },
  settings: { label: "Settings", render: () => <Settings /> },
} as const;

type PageKey = keyof typeof PAGES;

const PAGE_ICONS: Record<PageKey, LucideIcon> = {
  setup: Wrench,
  bot: BotIcon,
  history: Upload,
  mock: FlaskConical,
  conversations: MessagesSquare,
  knowledge: GitBranch,
  settings: SettingsIcon,
};

export function App(): JSX.Element {
  const [page, setPage] = useState<PageKey>("setup");
  const { theme, toggle } = useTheme();

  return (
    <div className="layout">
      <nav className="sidebar" aria-label="Primary">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <Sparkles size={20} aria-hidden="true" />
          </span>
          <h1>Nocheh Brain</h1>
        </div>
        {(Object.keys(PAGES) as PageKey[]).map((key) => {
          const Icon = PAGE_ICONS[key];
          const active = key === page;
          return (
            <button
              key={key}
              className={active ? "active" : ""}
              aria-current={active ? "page" : undefined}
              onClick={() => setPage(key)}
            >
              <span className="nav-icon">
                <Icon size={16} aria-hidden="true" />
              </span>
              {PAGES[key].label}
            </button>
          );
        })}
        <div className="sidebar-footer">
          <ThemeToggle theme={theme} onToggle={toggle} />
        </div>
      </nav>
      <main className="content">{PAGES[page].render()}</main>
    </div>
  );
}
