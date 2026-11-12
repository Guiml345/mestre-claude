import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  root,
  // Caminhos relativos: a extensão funciona servida de qualquer endereço.
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    // O Owlbear precisa de CORS para carregar a extensão do servidor de desenvolvimento.
    cors: { origin: "https://www.owlbear.rodeo" },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        background: resolve(root, "background.html"),
      },
    },
  },
});
