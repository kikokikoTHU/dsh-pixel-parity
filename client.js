/**
 * Pixel Parity panel — read-only run browser for the Web GUI.
 *
 * Two slot registrations:
 *   conversation.session.header.utilities → launcher button with a failure count
 *   shell.overlay                         → right-side drawer with run details
 */

window.__ModuleLoader__.load({
  id: 'dsh-pixel-parity',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const text = { color: 'var(--dsw-alias-text-primary, #1f2937)' }
    const muted = { color: 'var(--dsw-alias-text-secondary, #526176)' }
    const border = '1px solid var(--dsw-alias-border, #d7dee8)'
    const panelBg = 'var(--dsw-alias-bg-primary, #ffffff)'

    const styles = {
      button: {
        position: 'relative', width: 28, height: 28, borderRadius: 7, border,
        background: 'transparent', color: 'var(--dsw-alias-text-secondary, #526176)',
        fontSize: 10, fontWeight: 700, cursor: 'pointer', display: 'grid', placeItems: 'center',
        padding: 0, lineHeight: 1,
      },
      badge: {
        position: 'absolute', top: -4, right: -4, minWidth: 14, height: 14, padding: '0 3px',
        borderRadius: 999, background: 'var(--dsw-alias-status-danger, #c0392b)', color: '#fff',
        fontSize: 9, lineHeight: '14px', textAlign: 'center',
      },
      backdrop: { position: 'fixed', inset: 0, zIndex: 1000 },
      drawer: {
        position: 'absolute', top: 54, right: 14, bottom: 96, width: 384, maxWidth: '92vw',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: panelBg, border: '1px solid var(--dsw-alias-border-l2, #cfd7e3)',
        borderRadius: 12, boxShadow: '0 18px 48px rgba(24, 36, 56, 0.18)', ...text,
      },
      header: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
        borderBottom: border, fontSize: 12,
      },
      iconButton: {
        width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent',
        color: 'var(--dsw-alias-text-secondary, #526176)', cursor: 'pointer', fontSize: 12,
      },
      root: { padding: '6px 12px', fontSize: 10, borderBottom: border, ...muted },
      list: { padding: '8px 12px 12px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 },
      card: { border, borderRadius: 9, padding: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 },
      pill: {
        padding: '0 6px', borderRadius: 999, fontSize: 10, lineHeight: '16px',
        background: 'var(--dsw-alias-bg-secondary, #eef1f5)', ...muted,
      },
      caseRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 11 },
      thumb: { display: 'block', width: '100%', marginTop: 6, border, borderRadius: 6, cursor: 'zoom-in' },
    }

    const passCount = summary => (summary?.verified ?? 0) + (summary?.['image-verified'] ?? 0)
    const summaryLabel = summary => {
      const image = summary?.['image-verified'] ?? 0
      return `${passCount(summary)}✓ / ${summary?.failed ?? 0}✗${image > 0 ? ` (${image} image-verified)` : ''}`
    }
    const shortId = id => String(id ?? '').slice(0, 19)
    const statusColor = status => status === 'verified'
      ? 'var(--dsw-alias-status-success, #16794b)'
      : status === 'failed'
        ? 'var(--dsw-alias-status-danger, #c0392b)'
        : 'var(--dsw-alias-text-secondary, #526176)'

    // One shared store: the launcher and the drawer live in different slot trees.
    const state = { open: false, data: null, error: null, loading: false }
    const listeners = new Set()
    const notify = () => { for (const listener of listeners) listener() }

    async function loadOverview() {
      state.loading = true
      notify()
      try {
        const response = await fetch('/pixel-parity/overview', { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        state.data = await response.json()
        state.error = null
      } catch (failure) {
        state.error = String(failure?.message ?? failure)
      } finally {
        state.loading = false
        notify()
      }
    }

    function useStore() {
      const [, setTick] = useState(0)
      useEffect(() => {
        const listener = () => setTick(tick => tick + 1)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return state
    }

    const latestRun = data => (data?.roots ?? [])
      .flatMap(root => root.runs)
      .sort((left, right) => String(right.finishedAt ?? '').localeCompare(String(left.finishedAt ?? '')))[0]

    function Launcher() {
      const store = useStore()
      useEffect(() => {
        if (store.data === null && !store.loading) loadOverview()
      }, [])
      const latest = latestRun(store.data)
      const failed = latest?.summary?.failed ?? 0
      return h('button', {
        style: styles.button,
        title: latest === undefined ? 'Pixel parity' : `Pixel parity — ${summaryLabel(latest.summary)}`,
        'aria-label': 'Pixel parity',
        onClick: () => {
          state.open = !state.open
          notify()
          if (state.open) loadOverview()
        },
      },
        'PP',
        failed > 0 ? h('span', { style: styles.badge }, String(failed)) : null,
      )
    }

    function ViewportRow({ viewport }) {
      return h('div', { style: styles.caseRow },
        h('span', { style: { ...muted, width: 60 } }, viewport.id),
        h('span', { style: { color: statusColor(viewport.status), width: 92 } }, viewport.status),
        h('span', { style: muted }, viewport.pixels === null ? '' : `${(viewport.pixels * 100).toFixed(2)}%`),
        viewport.geometry === 'fail' ? h('span', { style: { color: statusColor('failed') } }, 'geometry fail') : null,
        viewport.styleDiffs > 0 ? h('span', { style: muted }, `${viewport.styleDiffs} style diffs`) : null,
      )
    }

    const imageUrl = path => `/pixel-parity/artifact?path=${encodeURIComponent(path)}`

    function RunCard({ run }) {
      const [expanded, setExpanded] = useState(false)
      const summary = run.summary ?? {}
      return h('div', { style: styles.card },
        h('div', { style: { ...styles.row, cursor: 'pointer' }, onClick: () => setExpanded(!expanded) },
          h('strong', null, shortId(run.runId)),
          h('span', { style: styles.pill }, `iter ${run.iteration}`),
          h('span', { style: muted }, summaryLabel(summary)),
          run.delta === null || run.delta === undefined
            ? null
            : h('span', { style: { color: run.delta.improved ? statusColor('verified') : statusColor('failed') } },
                `${run.delta.improved ? '' : '+'}${(run.delta.meanChange * 100).toFixed(2)}%`),
          h('span', { style: { ...muted, marginLeft: 'auto', fontSize: 10 } }, expanded ? 'Hide' : 'Show'),
        ),
        expanded
          ? h('div', null,
              (run.cases ?? []).map(entry => h('div', { key: entry.id, style: { paddingTop: 6 } },
                h('div', { style: { fontSize: 11, fontWeight: 600 } }, entry.id),
                (entry.viewports ?? []).map(viewport => h(ViewportRow, { key: viewport.id, viewport })),
                (entry.viewports ?? [])
                  .filter(viewport => viewport.diff !== null && viewport.diff !== undefined)
                  .map(viewport => h('img', {
                    key: `${viewport.id}-diff`,
                    style: styles.thumb,
                    alt: `${entry.id} ${viewport.id} diff`,
                    src: imageUrl(viewport.diff),
                    onClick: () => window.open(imageUrl(viewport.diff), '_blank', 'noopener'),
                  })),
              )),
            )
          : null,
      )
    }

    function Drawer() {
      const store = useStore()
      useEffect(() => {
        if (state.open) loadOverview()
      }, [store.open])
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape' && state.open) {
            state.open = false
            notify()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      if (!store.open) return null
      const roots = store.data?.roots ?? []
      const latest = latestRun(store.data)
      return h('div', {
        style: styles.backdrop,
        onClick: () => { state.open = false; notify() },
      },
        h('div', { style: styles.drawer, onClick: event => event.stopPropagation() },
          h('div', { style: styles.header },
            h('strong', null, 'Pixel parity'),
            latest === undefined ? null : h('span', { style: styles.pill }, summaryLabel(latest.summary)),
            h('span', { style: { flex: 1 } }),
            h('button', {
              style: styles.iconButton,
              title: 'Refresh',
              onClick: () => loadOverview(),
            }, '⟳'),
            h('button', {
              style: styles.iconButton,
              title: 'Close',
              onClick: () => { state.open = false; notify() },
            }, '×'),
          ),
          h('div', { style: styles.root }, roots.length === 0 ? 'no repository scanned yet' : roots.map(root => root.root).join(' · ')),
          h('div', { style: styles.list },
            store.error !== null
              ? h('div', { style: { color: statusColor('failed'), fontSize: 11 } }, `Panel unavailable: ${store.error}`)
              : store.data === null
                ? h('div', { style: { ...muted, fontSize: 11 } }, 'Loading…')
                : roots.length === 0
                  ? h('div', { style: { ...muted, fontSize: 11 } }, 'No .parity/runs found. Run parity_run first, then Refresh.')
                  : roots.map(root => h('div', { key: root.root },
                      root.runs.length === 0
                        ? h('div', { style: { ...muted, fontSize: 11 } }, 'No runs')
                        : root.runs.map(run => h(RunCard, { key: run.runId, run })),
                    )),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'pixel-parity-launcher',
          order: 40,
        }, Launcher))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'pixel-parity-drawer',
          order: 40,
        }, Drawer))
      },
    }
  },
})
