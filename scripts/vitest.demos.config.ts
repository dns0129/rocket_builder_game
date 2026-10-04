import { defineConfig } from 'vitest/config';

// 生成内置 demo 的脚本借用 vitest 运行（直接执行 TypeScript 源码，无需额外工具）
export default defineConfig({
  test: {
    include: ['scripts/generateDemos.ts'],
    testTimeout: 1_800_000,
    silent: false,
  },
});
