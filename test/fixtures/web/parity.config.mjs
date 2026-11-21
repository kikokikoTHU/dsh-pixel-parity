import { fileURLToPath } from 'node:url'

const local = name => fileURLToPath(new URL(`./${name}`, import.meta.url))

export default {
  version: 2,
  viewports: [{ id: 'desktop', width: 800, height: 600, dpr: 1 }],
  defaults: {
    tolerance: 24,
    maxMismatch: 0.01,
    maxRegionMismatch: 0.4,
  },
  cases: [
    {
      id: 'exact',
      reference: { url: local('reference.html') },
      implementation: { url: local('implementation-exact.html') },
      anchors: {
        header: { ref: '[data-parity="header"]', impl: '[data-parity="header"]' },
        query: { ref: '[data-parity="query"]', impl: '[data-parity="query"]' },
        table: { ref: '[data-parity="table"]', impl: '[data-parity="table"]' },
      },
      masks: [{ ref: 'tbody', impl: 'tbody' }],
    },
    {
      id: 'shifted',
      reference: { url: local('reference.html') },
      implementation: { url: local('implementation.html') },
      anchors: {
        header: { ref: '[data-parity="header"]', impl: '[data-parity="header"]' },
        query: { ref: '[data-parity="query"]', impl: '[data-parity="query"]' },
      },
      masks: [{ ref: 'tbody', impl: 'tbody' }],
    },
    {
      id: 'masked',
      reference: { url: local('reference.html') },
      implementation: { url: local('implementation-masked.html') },
      anchors: {
        header: { ref: '[data-parity="header"]', impl: '[data-parity="header"]' },
        query: { ref: '[data-parity="query"]', impl: '[data-parity="query"]' },
      },
      masks: [{ ref: 'tbody', impl: 'tbody' }],
    },
  ],
}
