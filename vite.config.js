import { defineConfig } from 'vite';

// base './': 빌드 결과를 어느 경로에 올려도(정적 호스팅·공유 페이지) 상대 경로로 동작
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
});
