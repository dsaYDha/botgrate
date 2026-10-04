// 그래픽 품질 프리셋. 기본 '중간' = 중급 PC 1080p 60fps 목표.
export const QUALITY = {
  low: {
    pixelRatio: 0.8,
    shadowMapSize: 1024,
    shadowExtent: 55,
    grassRange: 50,
    grassDensity: 0.5,
    treeLodScale: 0.7,
    shrubLodScale: 0.7,
    terrainLevels: 10,
  },
  medium: {
    pixelRatio: 1,
    shadowMapSize: 2048,
    shadowExtent: 70,
    grassRange: 75,
    grassDensity: 0.8,
    treeLodScale: 1.0,
    shrubLodScale: 1.0,
    terrainLevels: 10,
  },
  high: {
    pixelRatio: 1,
    shadowMapSize: 4096,
    shadowExtent: 90,
    grassRange: 105,
    grassDensity: 1.0,
    treeLodScale: 1.35,
    shrubLodScale: 1.3,
    terrainLevels: 10,
  },
};
