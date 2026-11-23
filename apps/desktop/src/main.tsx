import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applySavedWindowSize } from "./adapters/windowSize";
import "./styles.css";

async function main() {
    try {
        await applySavedWindowSize();
    } catch {
        // No Tauri window (or no saved size): keep the configured default.
    }

    ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}

void main();
