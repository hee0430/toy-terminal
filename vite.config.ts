import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // Rust 빌드 산출물(exe)을 감시하면 Windows에서 EBUSY로 vite가 죽는다.
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
