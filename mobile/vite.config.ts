import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // iOS Safari 15 起支持 WebGL2 与模块 Worker，以此为下限
    target: ['es2020', 'safari15', 'chrome100', 'firefox100'],
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  // 手机与电脑在同一局域网时，可用电脑的 IP 访问开发服务器
  server: { host: true, port: 5174 },
  preview: { host: true, port: 4174 },
});
