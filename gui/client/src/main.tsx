import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css";
import { applySavedTheme } from "./theme.js";

applySavedTheme();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
