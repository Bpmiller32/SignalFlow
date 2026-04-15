// vite.config.ts - Vite build configuration
// Minimal setup: React plugin only, no extras needed.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
