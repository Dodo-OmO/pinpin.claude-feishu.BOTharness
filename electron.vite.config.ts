import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // 把所有 dependencies 留给 Node 运行时解析——避免 Vite 试图 bundle 含原生模块 / 可选原生 deps 的 Node 包
    // （如 @larksuiteoapi/node-sdk 拖入 ws → ws 条件 import bufferutil 找不到时报 resolve 错）
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'launcher/main/main.ts'),
      },
    },
    resolve: {
      alias: {
        '@supervisor': resolve(__dirname, 'supervisor'),
        '@ipc': resolve(__dirname, 'src/ipc'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'launcher/preload/preload.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'launcher/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'launcher/renderer/index.html'),
          terminal: resolve(__dirname, 'launcher/renderer/terminal.html'),
          workTerminal: resolve(__dirname, 'launcher/renderer/work-terminal.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'launcher/renderer'),
      },
    },
  },
});
