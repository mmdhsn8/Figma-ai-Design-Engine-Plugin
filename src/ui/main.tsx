import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { FW7_BUILD_ID } from "../shared/fw7-feature";
import styles from "./styles.css?inline";

(window as Window & { __fadBuildId?: string }).__fadBuildId = FW7_BUILD_ID;

const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);

const root = document.getElementById("root");
if (!root) throw new Error("Plugin UI root element is missing.");

type UiRenderProfile = { commits: number; actualDurationMs: number };
const profileUiRender: React.ProfilerOnRenderCallback = (...render) => {
  const current = window as Window & { __fadUiRenderProfile?: UiRenderProfile };
  const profile = current.__fadUiRenderProfile ?? { commits: 0, actualDurationMs: 0 };
  profile.commits++;
  profile.actualDurationMs += render[2];
  current.__fadUiRenderProfile = profile;
};

createRoot(root).render(
  <React.StrictMode>
    <React.Profiler id="Figma AI Design Engine" onRender={profileUiRender}>
      <App />
    </React.Profiler>
  </React.StrictMode>,
);
