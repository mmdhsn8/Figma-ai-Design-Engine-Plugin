import type { RefObject } from "react";
import type { PluginView } from "./workspace-routes";

export function NavigationDrawer({
  activeView,
  settingsOpen,
  drawerRef,
  closeButtonRef,
  onClose,
  onNavigate,
  onOpenSettings,
}: {
  activeView: PluginView;
  settingsOpen: boolean;
  drawerRef: RefObject<HTMLElement>;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  onNavigate: (view: "home" | "chat" | "history") => void;
  onOpenSettings: () => void;
}) {
  return (
    <div
      className="navigation-drawer-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="navigation-drawer"
        id="navigation-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="navigation-drawer-title"
      >
        <header className="navigation-drawer-header">
          <div>
            <span className="section-kicker">PAGES</span>
            <h2 id="navigation-drawer-title">Navigate</h2>
          </div>
          <button
            className="navigation-drawer-close"
            ref={closeButtonRef}
            type="button"
            aria-label="Close navigation drawer"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <nav className="navigation-drawer-links" aria-label="Plugin pages">
          <button
            className={`navigation-drawer-link ${settingsOpen ? "is-active" : ""}`}
            type="button"
            aria-current={settingsOpen ? "page" : undefined}
            onClick={onOpenSettings}
          >
            <span className="navigation-drawer-icon" aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
          <button
            className={`navigation-drawer-link ${!settingsOpen && activeView === "home" ? "is-active" : ""}`}
            type="button"
            aria-current={!settingsOpen && activeView === "home" ? "page" : undefined}
            onClick={() => onNavigate("home")}
          >
            <span className="navigation-drawer-icon" aria-hidden="true">⌂</span>
            <span>Home</span>
          </button>
          <button
            className={`navigation-drawer-link ${!settingsOpen && activeView === "chat" ? "is-active" : ""}`}
            type="button"
            aria-current={!settingsOpen && activeView === "chat" ? "page" : undefined}
            onClick={() => onNavigate("chat")}
          >
            <span className="navigation-drawer-icon" aria-hidden="true">✦</span>
            <span>Chat</span>
          </button>
          <button
            className={`navigation-drawer-link ${!settingsOpen && activeView === "history" ? "is-active" : ""}`}
            type="button"
            aria-current={!settingsOpen && activeView === "history" ? "page" : undefined}
            onClick={() => onNavigate("history")}
          >
            <span className="navigation-drawer-icon" aria-hidden="true">◷</span>
            <span>History</span>
          </button>
        </nav>
      </aside>
    </div>
  );
}

const moreItems: Array<{ view: PluginView; title: string; description: string }> = [
  { view: "design", title: "Generation Options", description: "Screens, target, style, and model" },
  { view: "progress", title: "Generation Progress", description: "Live task stages and recovery" },
  {
    view: "results",
    title: "Result & Preview",
    description: "Confirmed saved screens and actions",
  },
  {
    view: "layers",
    title: "Layers & Structure",
    description: "Verified task-owned Figma hierarchy",
  },
  { view: "brand-kit", title: "Brand Kit", description: "Brand colors and typography" },
  { view: "skills", title: "Skills", description: "Local design guidance" },
  { view: "system", title: "Design System", description: "Document-scoped native tokens" },
  { view: "assets", title: "Asset Library", description: "Local images, SVGs, and provenance" },
  {
    view: "activity",
    title: "Activity & Diagnostics",
    description: "Task stages and safe recovery data",
  },
  {
    view: "quality",
    title: "Quality Report",
    description: "Measured preflight and native findings",
  },
  { view: "json", title: "JSON Advanced", description: "Offline validate, edit, and apply" },
  { view: "help", title: "Help & Guide", description: "How this plugin handles native changes" },
  { view: "about", title: "About", description: "Version and project information" },
];

const moreOptionIcons: Record<PluginView, string> = {
  design: "✦",
  progress: "◷",
  results: "✓",
  layers: "▱",
  "brand-kit": "◈",
  skills: "✧",
  system: "▦",
  assets: "▧",
  activity: "≋",
  quality: "⬡",
  json: "{}",
  help: "?",
  about: "ⓘ",
  home: "⌂",
  chat: "✦",
  history: "◷",
  more: "•••",
  "brand-kit-create": "◈",
  "skill-detail": "✧",
  "skill-add": "+",
  settings: "⚙",
};

export function MoreOptionsAccordion({
  onNavigate,
}: {
  onNavigate: (view: PluginView) => void;
}) {
  return (
    <div
      className="more-options-panel"
      id="more-options-panel"
      role="region"
      aria-label="More options"
    >
      {moreItems.map((item) => (
        <button
          className="more-option"
          key={item.view}
          type="button"
          onClick={() => onNavigate(item.view)}
        >
          <span className="more-option-icon" aria-hidden="true">
            {moreOptionIcons[item.view]}
          </span>
          <span className="more-option-copy">
            <span>{item.title}</span>
            <small>{item.description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function MoreMenu({ onNavigate }: { onNavigate: (view: PluginView) => void }) {
  return (
    <section className="route-page more-page" aria-labelledby="route-heading">
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">WORKSPACE</span>
          <h1 id="route-heading" tabIndex={-1}>
            More
          </h1>
          <p className="page-description">Advanced tools and workspace areas.</p>
        </div>
      </div>
      <div className="more-grid">
        {moreItems.map((item) => (
          <button
            className="more-link-card"
            key={item.view}
            type="button"
            onClick={() => onNavigate(item.view)}
          >
            <span>{item.title}</span>
            <small>{item.description}</small>
            <span className="more-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
