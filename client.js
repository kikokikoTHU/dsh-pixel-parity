/**
 * Pixel Parity panel — read-only run browser for the Web GUI.
 *
 * Registered into `conversation.composer.dock`: a one-line summary that expands
 * into recent runs, per-case statuses, and diff thumbnails served by the Host.
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

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px', fontSize: 12, ...text },
      row: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' },
      badge: {
        padding: '0 6px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
        background: 'var(--dsw-alias-bg-secondary, #eef1f5)', ...muted,
      },
      panel: { border, borderRadius: 8, padding: 8, maxHeight: 280, overflow: 'auto' },
      card: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border, #e8edf2)' },
      caseRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' },
      thumb: { display: 'block', width: '100%', maxWidth: 360, marginTop: 6, border, borderRadius: 4 },
      button: {
        marginLeft: 'auto', padding: '2px 8px', fontSize: 11, cursor: 'pointer',
        border, borderRadius: 6, background: 'transparent', ...text,
      },
    }

    const statusColor = status => status === 'verified'
      ? 'var(--dsw-alias-status-success, #16794b)'
      : status === 'failed'
        ? 'var(--dsw-alias-status-danger, #c0392b)'
        : 'var(--dsw-alias-text-secondary, #526176)'

    const shortId = id => String(id ?? '').slice(0, 19)

    function ViewportRow({ viewport }) {
      return h('div', { style: styles.caseRow },
        h('span', { style: { ...muted, width: 64 } }, viewport.id),
        h('span', { style: { color: statusColor(viewport.status), width: 96 } }, viewport.status),
        h('span', { style: muted }, viewport.pixels === null ? '' : `${(viewport.pixels * 100).toFixed(2)}%`),
        viewport.geometry === 'fail' ? h('span', { style: { color: statusColor('failed') } }, 'geometry fail') : null,
        viewport.styleDiffs > 0 ? h('span', { style: muted }, `${viewport.styleDiffs} style diffs`) : null,
      )
    }

    function RunCard({ run, onToggle, expanded }) {
      const summary = run.summary ?? {}
      return h('div', { style: styles.card },
        h('div', { style: styles.row, onClick: onToggle },
          h('strong', { style: text }, shortId(run.runId)),
          h('span', { style: styles.badge }, `iter ${run.iteration}`),
          h('span', { style: muted }, `${summary.verified ?? 0}✓ ${summary.failed ?? 0}✗`),
          run.delta !== null && run.delta !== undefined
            ? h('span', { style: { color: run.delta.improved ? statusColor('verified') : statusColor('failed') } },
                `${run.delta.improved ? '' : '+'}${(run.delta.meanChange * 100).toFixed(2)}%`)
            : null,
          h('span', { style: { ...muted, marginLeft: 'auto', fontSize: 11 } }, expanded ? 'Hide' : 'Show'),
        ),
        expanded
          ? h('div', { style: { paddingTop: 4 } },
              (run.cases ?? []).map(entry => h('div', { key: entry.id, style: { padding: '2px 0' } },
                h('div', { style: { fontWeight: 600 } }, entry.id),
                (entry.viewports ?? []).map(viewport => h(ViewportRow, { key: viewport.id, viewport })),
                (entry.viewports ?? [])
                  .filter(viewport => viewport.diff !== null && viewport.diff !== undefined)
                  .map(viewport => h('img', {
                    key: `${viewport.id}-diff`,
                    style: styles.thumb,
                    alt: `${entry.id} ${viewport.id} diff`,
                    src: `/pixel-parity/artifact?path=${encodeURIComponent(viewport.diff)}`,
                  })),
              )),
            )
          : null,
      )
    }

    function Panel() {
      const [open, setOpen] = useState(false)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [expandedRun, setExpandedRun] = useState(null)

      const load = useCallback(async () => {
        try {
          const response = await fetch('/pixel-parity/overview', { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setData(await response.json())
          setError(null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => {
        if (open) load()
      }, [open, load])

      const roots = data?.roots ?? []
      const runs = roots.flatMap(root => root.runs)
      const latest = [...runs].sort((left, right) => String(right.finishedAt ?? '').localeCompare(String(left.finishedAt ?? '')))[0]
      const summary = latest?.summary

      return h('div', { style: styles.root },
        h('div', { style: styles.row, onClick: () => setOpen(!open) },
          h('strong', { style: text }, 'Pixel parity'),
          latest
            ? h('span', { style: styles.badge }, `${summary?.verified ?? 0}✓ / ${summary?.failed ?? 0}✗`)
            : h('span', { style: muted }, 'no runs yet'),
          h('span', { style: muted }, open ? 'click to hide' : runs.length > 0 ? `${runs.length} runs` : ''),
          h('button', {
            style: styles.button,
            onClick: (event) => { event.stopPropagation(); load() },
          }, 'Refresh'),
        ),
        open
          ? h('div', { style: styles.panel },
              error !== null
                ? h('div', { style: { color: statusColor('failed') } }, `Panel unavailable: ${error}`)
                : roots.length === 0
                  ? h('div', { style: muted }, 'No .parity/runs found. Run parity_run first, then Refresh.')
                  : roots.map(root => h('div', { key: root.root },
                      h('div', { style: { ...muted, fontSize: 11, padding: '2px 0' } }, root.root),
                      root.runs.length === 0
                        ? h('div', { style: muted }, 'No runs')
                        : root.runs.map(run => h(RunCard, {
                            key: run.runId,
                            run,
                            expanded: expandedRun === run.dir,
                            onToggle: () => setExpandedRun(expandedRun === run.dir ? null : run.dir),
                          })),
                    )),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'pixel-parity',
          order: 6,
        }, Panel))
      },
    }
  },
})
