import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { installLogCapture } from "./logbuffer.js";

// Start capturing console warnings/errors into the diagnostic ring as early as
// possible, so a bug report can include what happened before the user noticed.
installLogCapture();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
