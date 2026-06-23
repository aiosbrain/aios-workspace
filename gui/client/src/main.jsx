import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./app.css";
import { applySavedTheme } from "./theme.js";

applySavedTheme();

createRoot(document.getElementById("root")).render(<App />);
