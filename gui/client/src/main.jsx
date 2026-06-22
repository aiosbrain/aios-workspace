import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./app.css";

// Apply the saved theme before first paint (no flash). The workspace GUI is
// terminal-native: dark is the default; light is opt-in via the toggle.
const THEME_KEY = "aios.gui.theme";
const savedTheme = (() => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
})();
if (savedTheme !== "light") document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")).render(<App />);
