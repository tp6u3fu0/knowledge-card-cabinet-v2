import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LandingPage } from "./landing";
import "../app/globals.css";

const container = document.getElementById("root");
if (!container) throw new Error("找不到掛載點 #root");

createRoot(container).render(
  <StrictMode>
    <LandingPage />
  </StrictMode>,
);
