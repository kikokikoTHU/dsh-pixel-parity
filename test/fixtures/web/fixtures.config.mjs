import { fileURLToPath } from 'node:url'

const local = name => fileURLToPath(new URL(`./${name}`, import.meta.url))

export default {
  version: 2,
  viewports: [{ id: 'desktop', width: 400, height: 300, dpr: 1 }],
  cases: [
    {
      id: 'fixture',
      reference: { url: local('fixture-ref.html') },
      implementation: {
        url: local('fixture-impl.html'),
        fixtures: local('fixtures.mjs'),
      },
      waitFor: { impl: ['body[data-ready="1"]'] },
      anchors: {
        body: { ref: 'body', impl: 'body' },
      },
    },
  ],
}
