import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import styles from "./styles.css?inline";

const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);

const root = document.getElementById("root");
if (!root) throw new Error("Plugin UI root element is missing.");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
