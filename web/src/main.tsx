// main.tsx - React entry point
// Mounts the App component into the #root div defined in index.html.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// mount the app
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
