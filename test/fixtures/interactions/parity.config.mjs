import { fileURLToPath } from 'node:url'

const local = name => fileURLToPath(new URL(`./${name}`, import.meta.url))

export default {
  version: 2,
  viewports: [{ id: 'small', width: 400, height: 220, dpr: 1 }],
  defaults: { tolerance: 24, maxMismatch: 0.01, maxRegionMismatch: 0.4 },
  cases: [
    {
      id: 'steps',
      reference: { url: local('reference.html') },
      implementation: {
        url: local('implementation.html'),
        steps: [
          { action: 'click', selector: '#reveal' },
          { action: 'wait', ms: 50 },
        ],
      },
      anchors: {
        panel: { ref: '[data-parity="panel"]', impl: '[data-parity="panel"]' },
      },
    },
    {
      id: 'iframe',
      reference: { url: local('frame-host.html') },
      implementation: { url: local('frame-host.html') },
      anchors: {
        inner: {
          ref: 'iframe#frame >>> [data-parity="inner"]',
          impl: { selector: '[data-parity="inner"]', frame: 'iframe#frame' },
        },
      },
    },
  ],
}
