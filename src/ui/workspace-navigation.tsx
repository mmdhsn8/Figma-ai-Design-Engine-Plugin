import type { PluginView } from "./workspace-routes";

const primaryItems: Array<{ view: PluginView; label: string; icon: string }> = [
  { view: "home", label: "Home", icon: "⌂" },
  { view: "chat", label: "Chat", icon: "✦" },
  { view: "history", label: "History", icon: "◷" },
];

export function PrimaryNavigation({
  activeView,
  onNavigate,
}: {
  activeView: PluginView;
  onNavigate: (view: PluginView) => void;
}) {
  const primaryView = primaryItems.some(({ view }) => view === activeView) ? activeView : undefined;
  return (
    <nav className="primary-nav" aria-label="Main navigation">
      {primaryItems.map(({ view, label, icon }) => (
        <button
          className={`nav-item ${primaryView === view ? "is-active" : ""}`}
          key={view}
          type="button"
          aria-current={primaryView === view ? "page" : undefined}
          onClick={() => onNavigate(view)}
        >
          <span className="nav-icon" aria-hidden="true">
            {icon}
          </span>
          <span>{label}</span>
        </button>
      ))}
    </nav>
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
