import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  server: { host: true },
  // mobile/ 是独立的手机版项目，有自己的依赖与测试
  test: { exclude: [...configDefaults.exclude, 'mobile/**'] },
});
