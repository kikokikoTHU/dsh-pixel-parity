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
      backdrop: { position: 'fixed', inset: 0, zIndex: 5000 },
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
      repoRow: { display: 'flex', gap: 6, padding: '6px 12px', borderBottom: border },
      input: {
        flex: 1, minWidth: 0, border, borderRadius: 6, padding: '3px 6px', fontSize: 11,
        background: 'transparent', color: 'inherit', outline: 'none',
      },
      message: { padding: '4px 12px', fontSize: 10, borderBottom: border, ...muted },
      diagnosis: { padding: '6px 12px', fontSize: 10, borderBottom: border, maxHeight: 140, overflow: 'auto' },
      viewerBackdrop: { position: 'fixed', inset: 0, zIndex: 6000, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      viewerPanel: { width: '92vw', height: '88vh', background: '#fff', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--dsw-alias-border, #d7dee8)' },
      projectBackdrop: { position: 'fixed', inset: 0, zIndex: 5500, background: 'rgba(15, 23, 42, 0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      projectPanel: { width: '92vw', height: '88vh', background: '#fff', borderRadius: 10, border: '1px solid #e5eaf1', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      projectHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #eef2f7' },
      projectBody: { flex: 1, overflow: 'auto', padding: 16, background: '#fbfcfe' },
      projectCard: { background: '#fff', border: '1px solid #e5eaf1', borderRadius: 8, padding: 12, marginBottom: 10 },
      projectRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid #f4f7fb' },
      viewerHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: border, fontSize: 12 },      repoSection: { marginTop: 10, paddingTop: 8, borderTop: border },
      repoHeader: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, paddingBottom: 4, overflow: 'hidden' },
      logBox: { marginTop: 10, padding: '8px 10px', border: '1px solid #e5eaf1', borderRadius: 8, background: '#fbfcfe' },
      logRow: { display: 'flex', gap: 6, fontSize: 9.5, color: '#475569', padding: '2px 0', fontFamily: '"Cascadia Code", Consolas, monospace' },
      taskCard: { border: '1px solid var(--dsw-alias-border, #d7dee8)', borderRadius: 8, padding: '8px 10px', margin: '8px 12px 0', background: 'var(--dsw-alias-bg-secondary, #f7f9fc)' },
      taskRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 },
      taskBtn: { border, background: 'transparent', borderRadius: 6, padding: '2px 8px', fontSize: 10, cursor: 'pointer', ...text },
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
    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
    const t = {
      refresh: zh ? '刷新' : 'Refresh',
      close: zh ? '关闭' : 'Close',
      repo: zh ? '仓库路径（可选）' : 'Repo path (optional)',
      latest: zh ? '最近' : 'Latest',
      loading: zh ? '加载中…' : 'Loading…',
      empty: zh ? '还没有 .parity/runs，先跑一次 parity_run。' : 'No .parity/runs found. Run parity_run first.',
      failed: zh ? '面板不可用' : 'Panel unavailable',
      open: zh ? '打开 Pixel parity' : 'Open Pixel parity',
      run: zh ? '用最近一次参数运行' : 'Run with the last parity_run arguments',
      approve: zh ? '批准最新基线' : 'Approve the latest baseline',
      diagnose: zh ? '诊断最新 run' : 'Diagnose the latest run',
    }
    const statusColor = status => status === 'verified'
      ? 'var(--dsw-alias-status-success, #16794b)'
      : status === 'failed'
        ? 'var(--dsw-alias-status-danger, #c0392b)'
        : 'var(--dsw-alias-text-secondary, #526176)'

    const storedRepo = (() => {
      try { return localStorage.getItem('pixel-parity.repo') ?? '' } catch { return '' }
    })()

    // One shared store: the launcher and the drawer live in different slot trees.
    const state = { open: false, data: null, tasks: null, error: null, loading: false, repo: storedRepo, message: null, diagnosis: null, viewer: null, pendingDelete: null, logs: [], projects: null, projectsOpen: false, project: null, projectStep: 1, projectDraft: { repo: '', baseCommit: 'HEAD', config: 'parity.config.mjs', name: '' }, sourceDraft: '', projectBusy: false, creating: false, roundViewer: null }
    const listeners = new Set()
    const notify = () => { for (const listener of listeners) listener() }

    async function loadTasks() {
      try {
        const query = state.repo.length > 0 ? `?repo=${encodeURIComponent(state.repo)}` : ''
        const response = await fetch(`/pixel-parity/tasks${query}`, { cache: 'no-store' })
        if (!response.ok) return
        const body = await response.json()
        state.tasks = body.tasks ?? []
        notify()
      } catch {}
    }

    async function loadOverview() {
      state.loading = true
      notify()
      try {
        const query = state.repo.length > 0 ? `?repo=${encodeURIComponent(state.repo)}` : ''
        const response = await fetch(`/pixel-parity/overview${query}`, { cache: 'no-store' })
        if (!response.ok) {
          let detail = `HTTP ${response.status}`
          try {
            const body = await response.json()
            if (typeof body?.error === 'string') detail = body.error
          } catch {}
          throw new Error(detail)
        }
        state.data = await response.json()
        state.error = null
      } catch (failure) {
        state.error = String(failure?.message ?? failure)
      } finally {
        state.loading = false
        notify()
      }
    }

    function setRepo(value) {
      state.repo = value.trim()
      try { localStorage.setItem('pixel-parity.repo', state.repo) } catch {}
      loadOverview()
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

    async function startPanelRun() {
      state.message = zh ? '已启动运行…' : 'Starting run…'
      notify()
      try {
        const response = await fetch('/pixel-parity/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        pollPanelJob()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    function pollPanelJob() {
      const timer = setInterval(async () => {
        try {
          const response = await fetch('/pixel-parity/job', { cache: 'no-store' })
          const job = await response.json()
          if (job?.status === 'done') {
            clearInterval(timer)
            state.message = zh ? `完成：${job.summary?.verified ?? 0}✓` : `Done: ${job.summary?.verified ?? 0}✓`
            notify()
            loadOverview()
          } else if (job?.status === 'error') {
            clearInterval(timer)
            state.message = `${zh ? '失败：' : 'Failed: '}${job.error}`
            notify()
          }
        } catch {}
      }, 1000)
    }

    async function approveLatest() {
      const latest = latestRun(state.data)
      if (latest === undefined) return
      try {
        const response = await fetch('/pixel-parity/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runDir: latest.dir }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        state.message = zh
          ? `已批准 ${body.approved?.length ?? 0} 个基线`
          : `Approved ${body.approved?.length ?? 0} baseline(s)`
        notify()
        loadOverview()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    async function showReport(target) {
      const task = target ?? state.tasks?.[0]
      if (task === undefined) return
      if (task.status !== 'converged' && task.status !== 'failed') {
        state.message = zh
          ? '先运行一次任务，再生成报告'
          : 'Run the task once before generating a report'
        notify()
        return
      }
      state.message = zh ? '正在生成报告…' : 'Generating report…'
      notify()
      try {
        const response = await fetch('/pixel-parity/task/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: task.id }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        state.viewer = task.id
        state.message = null
        notify()
        loadTasks()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    async function deleteTaskAction(task) {
      if (state.pendingDelete !== task.id) {
        state.pendingDelete = task.id
        state.message = zh ? `再次点击 Delete 确认删除 ${task.id}` : `Click Delete again to confirm removing ${task.id}`
        notify()
        return
      }
      state.pendingDelete = null
      try {
        const response = await fetch('/pixel-parity/task/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId: task.id }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        if (state.viewer === task.id) state.viewer = null
        state.message = null
        notify()
        loadTasks()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }
    async function diagnoseLatest() {
      const latest = latestRun(state.data)
      if (latest === undefined) return
      try {
        const response = await fetch(`/pixel-parity/diagnose?runDir=${encodeURIComponent(latest.dir)}`, { cache: 'no-store' })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        state.diagnosis = body
        state.message = null
        notify()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    const ComponentBase = React.Component ?? class {
      constructor(props) { this.props = props; this.state = {} }
    }

    class PanelBoundary extends ComponentBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: String(error?.message ?? error) }
      }

      render() {
        if (this.state.error !== null) {
          return h('div', {
            style: {
              position: 'fixed', top: 52, right: 12, zIndex: 2001, maxWidth: 420,
              padding: '8px 10px', background: '#fff', border: '1px solid #c0392b',
              borderRadius: 6, fontSize: 10, color: '#c0392b',
            },
          }, `Pixel parity panel error: ${this.state.error}`)
        }
        return this.props.children
      }
    }

    function ReportViewer() {
      const store = useStore()
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape' && state.viewer !== null) {
            state.viewer = null
            notify()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      if (store.viewer === null) return null
      const source = `/pixel-parity/task/report-file?taskId=${encodeURIComponent(store.viewer)}`
      return h('div', {
        style: styles.viewerBackdrop,
        onClick: () => { state.viewer = null; notify() },
      },
        h('div', { style: styles.viewerPanel, onClick: event => event.stopPropagation() },
          h('div', { style: styles.viewerHeader },
            h('strong', null, `Report · ${store.viewer}`),
            h('span', { style: { flex: 1 } }),
            h('a', {
              style: { ...styles.taskBtn, textDecoration: 'none', display: 'inline-block' },
              href: source,
              download: `${store.viewer}-report.html`,
            }, 'Download'),
            h('button', {
              style: styles.iconButton,
              onClick: () => { state.viewer = null; notify() },
            }, '×'),
          ),
          h('iframe', {
            src: source,
            title: `Report ${store.viewer}`,
            style: { width: '100%', flex: 1, border: 'none', background: '#fff' },
          }),
        ),
      )
    }

    async function runRepo(repo) {
      state.message = zh ? `正在批量运行 ${repo}` : `Running ${repo}`
      notify()
      try {
        const response = await fetch('/pixel-parity/repo/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        state.message = zh ? `批量运行 0/${body.total}` : `Batch 0/${body.total}`
        notify()
        const timer = setInterval(async () => {
          try {
            const jobResponse = await fetch('/pixel-parity/repo/job')
            const job = await jobResponse.json().catch(() => null)
            if (job === null) return
            if (job.status === 'running') {
              state.message = zh ? `批量运行 ${job.done}/${job.total}` : `Batch ${job.done}/${job.total}`
              notify()
            } else {
              clearInterval(timer)
              state.message = zh
                ? `批量完成：${job.done}/${job.total}${job.failed > 0 ? `，${job.failed} 个失败` : ''}`
                : `Batch done: ${job.done}/${job.total}${job.failed > 0 ? `, ${job.failed} failed` : ''}`
              notify()
              loadTasks()
            }
          } catch {}
        }, 1000)
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }


    async function loadLogs() {
      try {
        const response = await fetch('/pixel-parity/logs?limit=30')
        const body = await response.json().catch(() => ({}))
        if (response.ok) {
          state.logs = body.entries ?? []
          notify()
        }
      } catch {}
    }

    async function loadProjects() {
      try {
        const response = await fetch('/pixel-parity/projects')
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        state.projects = body.projects ?? []
        notify()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    function openProjects() {
      state.projectsOpen = true
      state.project = null
      state.creating = false
      state.projectStep = 1
      loadProjects()
      notify()
    }

    function projectGate(project) {
      const terminal = ['matched', 'needs-review', 'unmatched']
      const pending = project.sources.filter(source => !terminal.includes(source.status) && source.status !== 'failed').length
      const failed = project.sources.filter(source => source.status === 'failed').length
      if (project.sources.length === 0) return { ready: false, reason: '先添加一个设计图/原型' }
      if (pending > 0) return { ready: false, reason: `${pending} 个设计源正在分析` }
      if (failed > 0) return { ready: false, reason: '有设计源分析失败，请重试或删除' }
      if (project.subtasks.length === 0) return { ready: false, reason: '没有可对齐的子任务' }
      return { ready: true, reason: '' }
    }

    async function projectPost(url, body) {
      state.projectBusy = true
      state.message = null
      notify()
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        state.projectBusy = false
        notify()
      }
    }

    async function createProjectFromDraft() {
      try {
        const payload = await projectPost('/pixel-parity/project/create', {
          repo: state.projectDraft.repo,
          baseCommit: state.projectDraft.baseCommit || 'HEAD',
          config: state.projectDraft.config || 'parity.config.mjs',
          name: state.projectDraft.name || undefined,
        })
        state.project = payload.project
        state.creating = false
        state.projectStep = 1
        loadProjects()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    async function addProjectSource(kind) {
      if (state.project === null || state.sourceDraft.trim().length === 0) return
      try {
        const payload = await projectPost('/pixel-parity/project/source', {
          projectId: state.project.id,
          kind,
          location: state.sourceDraft.trim(),
        })
        state.project = payload.project
        state.sourceDraft = ''
        loadProjects()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    async function removeProjectSource(sourceId) {
      if (state.project === null) return
      try {
        const payload = await projectPost('/pixel-parity/project/source/delete', { projectId: state.project.id, sourceId })
        state.project = payload.project
        loadProjects()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    async function projectToggleSubtask(id) {
      if (state.project === null) return
      const selected = new Set(state.project.nextSelection ?? [])
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      state.project.nextSelection = [...selected]
      notify()
      try {
        const payload = await projectPost('/pixel-parity/project/selection', {
          projectId: state.project.id,
          selection: state.project.nextSelection,
        })
        state.project = payload.project
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    async function startProjectRound() {
      if (state.project === null) return
      try {
        const payload = await projectPost('/pixel-parity/project/round', { projectId: state.project.id })
        state.message = `Round 执行中… (${payload.jobId ?? ''})`
        const timer = setInterval(async () => {
          try {
            const response = await fetch('/pixel-parity/project/job')
            const job = await response.json().catch(() => null)
            if (job === null) return
            if (job.status === 'running') {
              state.message = 'Round 执行中…'
              notify()
              return
            }
            clearInterval(timer)
            if (job.status === 'error') {
              state.message = job.error
              notify()
              return
            }
            state.message = null
            const projectResponse = await fetch('/pixel-parity/projects')
            const projectsBody = await projectResponse.json().catch(() => ({}))
            const fresh = (projectsBody.projects ?? []).find(item => item.id === state.project.id)
            if (fresh !== undefined) state.project = fresh
            notify()
          } catch {}
        }, 1000)
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    function openRoundReport(projectId, round) {
      state.roundViewer = { projectId, round }
      notify()
    }

    async function deleteCurrentProject() {
      if (state.project === null) return
      if (state.pendingDelete !== state.project.id) {
        state.pendingDelete = state.project.id
        state.message = '再次点击 Delete 确认删除项目'
        notify()
        return
      }
      state.pendingDelete = null
      try {
        await projectPost('/pixel-parity/project/delete', { projectId: state.project.id })
        state.project = null
        state.projectsOpen = false
        state.message = null
        loadProjects()
      } catch (failure) {
        state.message = String(failure?.message ?? failure)
        notify()
      }
    }

    const projectCss = `
      .ppj-backdrop { position: fixed; inset: 0; z-index: 5500; background: rgba(15, 23, 42, .32); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; }
      .ppj-panel { width: min(1120px, 95vw); height: min(800px, 90vh); background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 24px 70px rgba(15, 23, 42, .22); display: grid; grid-template-columns: 218px 1fr; overflow: hidden; color: #0f172a; }
      .ppj-rail { background: #fbfcfe; border-right: 1px solid #eef2f7; padding: 18px 14px; display: flex; flex-direction: column; gap: 4px; }
      .ppj-brand { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; margin-bottom: 14px; }
      .ppj-mark { width: 24px; height: 24px; border-radius: 7px; background: #111827; color: #fff; display: grid; place-items: center; font-size: 10px; font-weight: 700; }
      .ppj-rail-label { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #94a3b8; margin: 4px 6px 6px; }
      .ppj-step { display: flex; gap: 9px; padding: 8px; border-radius: 8px; border: 0; background: transparent; text-align: left; cursor: pointer; width: 100%; }
      .ppj-step:hover { background: #f1f5f9; }
      .ppj-step.active { background: #eef2f7; }
      .ppj-step:disabled { opacity: .45; cursor: not-allowed; }
      .ppj-dot { width: 20px; height: 20px; border-radius: 50%; border: 1px solid #cbd5e1; background: #fff; color: #64748b; display: grid; place-items: center; font-size: 10px; flex: none; }
      .ppj-step.active .ppj-dot { background: #111827; border-color: #111827; color: #fff; }
      .ppj-step.done .ppj-dot { background: #dcfce7; border-color: #86efac; color: #15803d; }
      .ppj-step b { display: block; font-size: 12px; font-weight: 600; color: #334155; }
      .ppj-step small { display: block; font-size: 10px; color: #94a3b8; margin-top: 1px; }
      .ppj-rail-note { margin-top: auto; font-size: 10px; line-height: 1.65; color: #94a3b8; border-top: 1px solid #eef2f7; padding-top: 10px; }
      .ppj-main { display: flex; flex-direction: column; min-width: 0; background: #fff; }
      .ppj-head { display: flex; align-items: flex-start; gap: 10px; padding: 18px 22px 14px; border-bottom: 1px solid #eef2f7; }
      .ppj-head h2 { margin: 0; font-size: 16px; letter-spacing: -.01em; }
      .ppj-head p { margin: 3px 0 0; font-size: 11px; color: #64748b; }
      .ppj-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
      .ppj-body { flex: 1; overflow: auto; padding: 18px 22px; background: #fff; }
      .ppj-foot { border-top: 1px solid #eef2f7; padding: 12px 22px; display: flex; align-items: center; gap: 10px; background: #fff; }
      .ppj-foot .ppj-note { font-size: 11px; color: #94a3b8; }
      .ppj-btn { height: 30px; padding: 0 12px; border-radius: 6px; border: 1px solid #d8e0ea; background: #fff; color: #0f172a; font-size: 12px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
      .ppj-btn:hover { border-color: #94a3b8; }
      .ppj-btn.primary { background: #111827; border-color: #111827; color: #fff; font-weight: 600; }
      .ppj-btn.primary:hover { background: #1f2937; }
      .ppj-btn:disabled { background: #f1f5f9; border-color: #e2e8f0; color: #94a3b8; cursor: not-allowed; }
      .ppj-btn.danger { color: #b91c1c; border-color: #fecaca; }
      .ppj-btn.ghost { border-color: transparent; }
      .ppj-card { border: 1px solid #e5eaf1; border-radius: 10px; margin-bottom: 12px; }
      .ppj-card-h { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #eef2f7; }
      .ppj-card-h b { font-size: 12px; }
      .ppj-card-h .ppj-hint { margin-left: auto; font-size: 10px; color: #94a3b8; }
      .ppj-card-b { padding: 14px; }
      .ppj-meta { display: flex; gap: 6px; flex-wrap: wrap; }
      .ppj-chip { border: 1px solid #e2e8f0; background: #f8fafc; color: #475569; border-radius: 999px; padding: 3px 9px; font-size: 10px; }
      .ppj-chip.mono { font-family: "Cascadia Code", Consolas, monospace; }
      .ppj-kv { font-size: 11px; color: #64748b; line-height: 1.65; }
      .ppj-kv b { color: #0f172a; }
      .ppj-input { height: 32px; width: 100%; border: 1px solid #dbe3ee; border-radius: 6px; padding: 0 10px; font-size: 12px; color: #0f172a; background: #fff; outline: none; }
      .ppj-input:focus { border-color: #111827; box-shadow: 0 0 0 2px rgba(17, 24, 39, .08); }
      .ppj-grid { display: grid; gap: 9px; }
      .ppj-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #f4f7fb; }
      .ppj-row:last-child { border-bottom: none; }
      .ppj-row .ppj-grow { flex: 1; min-width: 0; }
      .ppj-src { font-size: 11px; font-family: "Cascadia Code", Consolas, monospace; color: #334155; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ppj-pill { border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
      .ppj-pill.ok { background: #e8f8ef; color: #15803d; }
      .ppj-pill.warn { background: #fff7e6; color: #b45309; }
      .ppj-pill.bad { background: #fdecec; color: #b91c1c; }
      .ppj-pill.neutral { background: #f1f5f9; color: #475569; }
      .ppj-progress { height: 5px; border-radius: 3px; background: #eef2f7; overflow: hidden; margin-top: 8px; }
      .ppj-progress > i { display: block; height: 100%; background: #111827; }
      .ppj-empty { border: 1px dashed #d8e0ea; border-radius: 9px; padding: 22px; text-align: center; color: #94a3b8; font-size: 11px; }
      .ppj-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .ppj-table th { text-align: left; font-size: 10px; font-weight: 600; color: #64748b; padding: 7px 8px; border-bottom: 1px solid #eef2f7; }
      .ppj-table td { padding: 9px 8px; border-bottom: 1px solid #f4f7fb; color: #334155; }
      .ppj-table tr:last-child td { border-bottom: none; }
      .ppj-check { width: 15px; height: 15px; accent-color: #111827; }
      .ppj-round { border: 1px solid #e5eaf1; border-radius: 8px; padding: 11px 13px; margin-bottom: 8px; }
      .ppj-round.now { border-color: #111827; }
      .ppj-round-h { display: flex; align-items: center; gap: 8px; }
      .ppj-round-h b { font-size: 12px; }
      .ppj-round-kv { font-size: 10px; color: #64748b; margin-top: 4px; }
      .ppj-close { width: 28px; height: 28px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: #64748b; font-size: 16px; cursor: pointer; }
      .ppj-close:hover { background: #f1f5f9; color: #0f172a; }
      .ppj-project { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border: 1px solid #e5eaf1; border-radius: 8px; margin-bottom: 8px; cursor: pointer; }
      .ppj-project:hover { border-color: #111827; background: #fbfcfe; }
      .ppj-project b { font-size: 12px; }
      .ppj-project .ppj-repo { font-size: 10px; color: #94a3b8; font-family: "Cascadia Code", Consolas, monospace; }
      .ppj-form { max-width: 560px; }
      .ppj-label { display: block; font-size: 10px; color: #64748b; margin-bottom: 4px; }
      .ppj-alert { border: 1px solid #fde68a; background: #fffbeb; color: #92400e; border-radius: 7px; padding: 8px 10px; font-size: 11px; margin-bottom: 10px; }
    `

    function ProjectOverlay() {
      const store = useStore()
      if (!store.projectsOpen) return null
      const project = store.project
      const gate = project === null ? null : projectGate(project)
      const close = () => { state.projectsOpen = false; state.project = null; notify() }
      const pillClass = status => {
        if (['matched', 'ready', 'completed', 'converged'].includes(status)) return 'ok'
        if (['needs-review', 'analyzing', 'running', 'queued', 'draft'].includes(status)) return 'warn'
        if (['failed', 'unmatched', 'interrupted'].includes(status)) return 'bad'
        return 'neutral'
      }
      const pill = (status, label) => h('span', { className: `ppj-pill ${pillClass(status)}` }, label ?? status)
      const closeButton = h('button', { className: 'ppj-close', onClick: close, title: '关闭' }, '×')
      const head = (title, subtitle, actions = []) => h('div', { className: 'ppj-head' },
        h('div', null,
          h('h2', null, title),
          subtitle === undefined ? null : h('p', null, subtitle),
        ),
        h('div', { className: 'ppj-actions' }, actions, closeButton),
      )
      const rail = (step, projectMode) => h('aside', { className: 'ppj-rail' },
        h('div', { className: 'ppj-brand' }, h('span', { className: 'ppj-mark' }, 'PP'), 'Pixel parity'),
        h('div', { className: 'ppj-rail-label' }, projectMode ? 'Project setup' : 'Projects'),
        projectMode
          ? h(React.Fragment, null,
              h('button', {
                className: `ppj-step ${step === 1 ? 'active' : ''}`,
                onClick: () => { state.projectStep = 1; notify() },
              }, h('span', { className: 'ppj-dot' }, '1'), h('span', null, h('b', null, '仓库与设计源'), h('small', null, '添加源即自动分析'))),
              h('button', {
                className: `ppj-step ${step === 2 ? 'active' : ''} ${gate.ready ? 'done' : ''}`,
                disabled: !gate.ready,
                onClick: () => { if (gate.ready) { state.projectStep = 2; notify() } },
              }, h('span', { className: 'ppj-dot' }, gate.ready ? '✓' : '2'), h('span', null, h('b', null, '生成子任务'), h('small', null, gate.ready ? '勾选本轮范围' : '等待全部分析'))),
              h('button', {
                className: `ppj-step ${step === 3 ? 'active' : ''}`,
                disabled: project.subtasks.length === 0,
                onClick: () => { if (project.subtasks.length > 0) { state.projectStep = 3; notify() } },
              }, h('span', { className: 'ppj-dot' }, project.rounds.length > 0 ? '✓' : '3'), h('span', null, h('b', null, '项目页'), h('small', null, '手动 Run next round'))),
            )
          : h('div', { className: 'ppj-kv' }, '一个项目 = repo + base commit + 设计源；分析与匹配自动完成。'),
        h('div', { className: 'ppj-rail-note' }, '分析自动执行；每轮由你手动触发，不会自动开始下一轮。'),
      )

      if (project === null) {
        const list = (store.projects ?? []).length === 0
          ? h('div', { className: 'ppj-empty' }, '还没有项目。先创建一个，再添加设计图或原型。')
          : (store.projects ?? []).map(item => h('div', {
              key: item.id,
              className: 'ppj-project',
              onClick: () => { state.project = item; state.projectStep = item.subtasks.length > 0 ? 3 : 1; notify() },
            },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('b', null, item.name),
                h('div', { className: 'ppj-repo' }, item.repo),
              ),
              pill(item.status),
              h('span', { className: 'ppj-kv' }, `${item.subtasks.length} subtasks · ${item.rounds.length} rounds`),
            ))
        return h('div', { className: 'ppj-backdrop', onClick: close },
          h('div', { className: 'ppj-panel', onClick: event => event.stopPropagation() },
            h('style', null, projectCss),
            rail(1, false),
            h('div', { className: 'ppj-main' },
              head('Projects', 'repo + base commit + 设计源，分析与匹配自动执行', [
                h('button', { className: 'ppj-btn primary', onClick: () => { state.creating = true; notify() } }, '+ 新建项目'),
              ]),
              h('div', { className: 'ppj-body' },
                store.creating
                  ? h('div', { className: 'ppj-form' },
                      h('div', { className: 'ppj-card' },
                        h('div', { className: 'ppj-card-h' }, h('b', null, '新建对齐项目')),
                        h('div', { className: 'ppj-card-b' },
                          h('div', { className: 'ppj-grid' },
                            h('label', null, h('span', { className: 'ppj-label' }, '仓库路径'), h('input', { className: 'ppj-input', placeholder: 'D:\\\\work\\\\anubis', value: state.projectDraft.repo, onChange: event => { state.projectDraft.repo = event.target.value; notify() } })),
                            h('label', null, h('span', { className: 'ppj-label' }, '基准 commit'), h('input', { className: 'ppj-input', placeholder: 'HEAD', value: state.projectDraft.baseCommit, onChange: event => { state.projectDraft.baseCommit = event.target.value; notify() } })),
                            h('label', null, h('span', { className: 'ppj-label' }, 'parity config'), h('input', { className: 'ppj-input', placeholder: 'parity.config.mjs', value: state.projectDraft.config, onChange: event => { state.projectDraft.config = event.target.value; notify() } })),
                            h('label', null, h('span', { className: 'ppj-label' }, '项目名称（可选）'), h('input', { className: 'ppj-input', placeholder: 'anubis', value: state.projectDraft.name, onChange: event => { state.projectDraft.name = event.target.value; notify() } })),
                          ),
                          h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
                            h('button', { className: 'ppj-btn', onClick: () => { state.creating = false; notify() } }, '取消'),
                            h('button', { className: 'ppj-btn primary', disabled: state.projectBusy || state.projectDraft.repo.trim() === '', onClick: createProjectFromDraft }, state.projectBusy ? '创建中…' : '创建项目'),
                          ),
                        ),
                      ),
                    )
                  : list,
              ),
            ),
          ),
        )
      }

      const stepOne = h(React.Fragment, null,
        h('div', { className: 'ppj-card' },
          h('div', { className: 'ppj-card-h' }, h('b', null, '仓库与基准'), h('span', { className: 'ppj-hint' }, 'worktree 隔离')),
          h('div', { className: 'ppj-card-b' },
            h('div', { className: 'ppj-meta' },
              h('span', { className: 'ppj-chip mono' }, project.repo),
              h('span', { className: 'ppj-chip mono' }, `base ${project.baseCommit.slice(0, 7)}`),
              h('span', { className: 'ppj-chip' }, project.config),
            ),
          ),
        ),
        h('div', { className: 'ppj-card' },
          h('div', { className: 'ppj-card-h' }, h('b', null, '设计源'), h('span', { className: 'ppj-hint' }, '添加后立即自动分析')),
          h('div', { className: 'ppj-card-b' },
            h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
              h('input', { className: 'ppj-input', style: { flex: 1 }, placeholder: 'https://… 或本地绝对路径', value: state.sourceDraft, onChange: event => { state.sourceDraft = event.target.value; notify() } }),
              h('button', { className: 'ppj-btn primary', disabled: state.projectBusy || state.sourceDraft.trim() === '', onClick: () => addProjectSource(state.sourceDraft.startsWith('http') ? 'url' : 'file') }, state.projectBusy ? '分析中…' : '添加'),
            ),
            project.sources.length === 0 ? h('div', { className: 'ppj-empty' }, '添加一个设计图或原型开始分析') : null,
            project.sources.map(source => h('div', { key: source.id, className: 'ppj-row' },
              pill(source.status),
              h('span', { className: 'ppj-grow ppj-src', title: source.location }, source.location),
              h('button', { className: 'ppj-btn ghost danger', onClick: () => removeProjectSource(source.id) }, '删除'),
            )),
          ),
        ),
        h('div', { className: 'ppj-card' },
          h('div', { className: 'ppj-card-h' }, h('b', null, '自动分析与匹配'), h('span', { className: 'ppj-hint' }, gate.reason || '全部分析完成')),
          h('div', { className: 'ppj-card-b' },
            h('div', { className: 'ppj-kv' }, `${project.sources.filter(source => ['matched', 'needs-review', 'unmatched'].includes(source.status)).length}/${project.sources.length} 个源已完成`),
            h('div', { className: 'ppj-progress' }, h('i', { style: { width: `${project.sources.length === 0 ? 0 : project.sources.filter(source => ['matched', 'needs-review', 'unmatched'].includes(source.status)).length / project.sources.length * 100}%` } })),
            project.matches.length === 0 ? null : h('div', { style: { marginTop: 10 } },
              project.matches.map(match => h('div', { key: match.sourceId, className: 'ppj-row' },
                h('span', { className: 'ppj-grow ppj-src' }, `${match.sourceId} → ${match.caseId}`),
                pill(match.status),
                h('span', { className: 'ppj-kv' }, `${Math.round(match.confidence * 100)}%`),
              )),
            ),
          ),
        ),
      )

      const stepTwo = h('div', { className: 'ppj-card' },
        h('div', { className: 'ppj-card-h' }, h('b', null, '生成子任务'), h('span', { className: 'ppj-hint' }, '勾选决定下一轮范围')),
        h('div', { className: 'ppj-card-b' },
          h('table', { className: 'ppj-table' },
            h('thead', null, h('tr', null, h('th', { style: { width: 34 } }, ''), h('th', null, '子任务'), h('th', null, 'case'), h('th', null, '置信度'))),
            h('tbody', null, project.subtasks.map(task => h('tr', { key: task.id },
              h('td', null, h('input', { className: 'ppj-check', type: 'checkbox', checked: (project.nextSelection ?? []).includes(task.id), onChange: () => projectToggleSubtask(task.id) })),
              h('td', null, h('b', null, task.title), task.needsReview ? h('div', { className: 'ppj-kv' }, '待复核，默认不勾选') : null),
              h('td', null, h('span', { className: 'ppj-chip mono' }, task.caseId)),
              h('td', null, `${Math.round(task.confidence * 100)}%`),
            ))),
          ),
        ),
      )

      const detail = h(React.Fragment, null,
        h('div', { className: 'ppj-card' },
          h('div', { className: 'ppj-card-b', style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('div', { style: { flex: 1 } },
              h('div', { className: 'ppj-kv' }, `${(project.nextSelection ?? []).length}/${project.subtasks.length} 个子任务已选 · 本轮不会自动执行`),
            ),
            h('button', { className: 'ppj-btn primary', disabled: state.projectBusy || (project.nextSelection ?? []).length === 0, onClick: startProjectRound }, 'Run next round'),
            h('button', { className: 'ppj-btn danger', onClick: deleteCurrentProject }, state.pendingDelete === project.id ? 'Confirm delete' : 'Delete'),
          ),
        ),
        h('div', { className: 'ppj-card' },
          h('div', { className: 'ppj-card-h' }, h('b', null, '本轮子任务')),
          h('div', { className: 'ppj-card-b' },
            project.subtasks.map(task => h('label', { key: task.id, className: 'ppj-row', style: { cursor: 'pointer' } },
              h('input', { className: 'ppj-check', type: 'checkbox', checked: (project.nextSelection ?? []).includes(task.id), onChange: () => projectToggleSubtask(task.id) }),
              h('span', { className: 'ppj-grow' }, task.title),
              task.needsReview ? pill('needs-review', '待复核') : null,
            )),
          ),
        ),
        h('div', { className: 'ppj-card' },
          h('div', { className: 'ppj-card-h' }, h('b', null, '轮次'), h('span', { className: 'ppj-hint' }, '每次点击只执行一轮')),
          h('div', { className: 'ppj-card-b' },
            project.rounds.length === 0 ? h('div', { className: 'ppj-empty' }, '还没有执行过轮次') : null,
            [...project.rounds].reverse().map(round => h('div', { key: round.id, className: `ppj-round ${round.status === 'running' ? 'now' : ''}` },
              h('div', { className: 'ppj-round-h' },
                h('b', null, `Round ${round.number}`),
                pill(round.status),
                h('span', { className: 'ppj-kv' }, `${round.selection.length} selected`),
                h('span', { style: { flex: 1 } }),
                round.status === 'completed' ? h('button', { className: 'ppj-btn', onClick: () => openRoundReport(project.id, round.number) }, 'Report') : null,
              ),
              h('div', { className: 'ppj-round-kv' }, round.summary === null || round.summary === undefined ? round.finishedAt ?? '' : `${round.summary.failed ?? 0} failed · ${round.summary.verified ?? 0} passed`),
            )),
          ),
        ),
      )

      const body = state.projectStep === 1 ? stepOne : state.projectStep === 2 ? stepTwo : detail
      const primary = state.projectStep === 1
        ? h('button', { className: 'ppj-btn primary', disabled: !gate.ready, title: gate.reason, onClick: () => { state.projectStep = 2; notify() } }, gate.ready ? '生成子任务 →' : gate.reason)
        : state.projectStep === 2
          ? h('button', { className: 'ppj-btn primary', onClick: () => { state.projectStep = 3; notify() } }, '进入项目页 →')
          : null
      return h('div', { className: 'ppj-backdrop', onClick: close },
        h('div', { className: 'ppj-panel', onClick: event => event.stopPropagation() },
          h('style', null, projectCss),
          rail(state.projectStep, true),
          h('div', { className: 'ppj-main' },
            head(project.name, `${project.repo} · base ${project.baseCommit.slice(0, 7)}`),
            h('div', { className: 'ppj-body' }, body),
            h('div', { className: 'ppj-foot' },
              h('button', { className: 'ppj-btn ghost', onClick: () => { state.project = null; loadProjects(); notify() } }, '← Projects'),
              h('span', { className: 'ppj-note' }, store.message ?? ''),
              h('span', { style: { flex: 1 } }),
              primary,
            ),
          ),
        ),
      )
    }


    function RoundReportViewer() {
      const store = useStore()
      if (store.roundViewer === null) return null
      const { projectId, round } = store.roundViewer
      const source = `/pixel-parity/project/report?projectId=${encodeURIComponent(projectId)}&round=${round}`
      return h('div', { style: styles.viewerBackdrop, onClick: () => { state.roundViewer = null; notify() } },
        h('div', { style: styles.viewerPanel, onClick: event => event.stopPropagation() },
          h('div', { style: styles.viewerHeader },
            h('strong', null, `Round ${round} report`),
            h('span', { style: { flex: 1 } }),
            h('a', { style: { ...styles.taskBtn, textDecoration: 'none' }, href: source, target: '_blank', rel: 'noopener' }, 'Open'),
            h('button', { style: styles.iconButton, onClick: () => { state.roundViewer = null; notify() } }, '×'),
          ),
          h('iframe', { src: source, style: { width: '100%', flex: 1, border: 'none', background: '#fff' } }),
        ),
      )
    }

    function Launcher() {
      const store = useStore()
      useEffect(() => {
        loadTasks()
        const timer = setInterval(() => { loadTasks() }, 10000)
        return () => clearInterval(timer)
      }, [])
      const tasks = store.tasks ?? []
      const active = tasks.filter(task => task.status !== 'converged' && task.status !== 'failed').length
      const button = h('button', {
        style: styles.button,
        title: `Pixel parity — ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
        'aria-label': 'Pixel parity',
        onClick: () => {
          state.open = !state.open
          notify()
          if (state.open) loadTasks()
        },
      },
        'PP',
        active > 0 ? h('span', { style: styles.badge }, String(active)) : null,
      )
      return h(React.Fragment, null, button, h(PanelBoundary, null, h(Drawer)), h(ProjectOverlay), h(ReportViewer), h(RoundReportViewer))
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
          h('span', {
            style: styles.pill,
            title: run.taskIteration === null || run.taskIteration === undefined
              ? `run iteration ${run.iteration}`
              : `task iteration ${run.taskIteration}/${run.taskMaxIterations ?? '?'} · run #${run.iteration}`,
          }, run.taskIteration === null || run.taskIteration === undefined
            ? `iter ${run.iteration}`
            : `task ${run.taskIteration}/${run.taskMaxIterations ?? '?'}`),
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
      const [draft, setDraft] = useState(store.repo)
      useEffect(() => {
        if (!state.open) return undefined
        loadTasks()
        loadLogs()
        const timer = setInterval(() => { loadTasks(); loadLogs() }, 4000)
        return () => clearInterval(timer)
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
      const taskCount = (store.tasks ?? []).length
      return h('div', {
        style: styles.backdrop,
        onClick: () => { state.open = false; notify() },
      },
        h('div', { style: styles.drawer, onClick: event => event.stopPropagation() },
          h('div', { style: styles.header },
            h('strong', null, 'Pixel parity'),
            h('span', { style: styles.pill }, `${taskCount} task${taskCount === 1 ? '' : 's'}`),
            h('span', { style: { flex: 1 } }),
            h('button', {
              style: styles.taskBtn,
              onClick: openProjects,
            }, 'Projects'),
            h('button', {
              style: styles.iconButton,
              title: t.refresh,
              onClick: () => loadTasks(),
            }, '⟳'),
            h('button', {
              style: styles.iconButton,
              title: t.close,
              onClick: () => { state.open = false; notify() },
            }, '×'),
          ),
          (() => {
            const groups = new Map()
            for (const task of store.tasks ?? []) {
              if (!groups.has(task.repo)) groups.set(task.repo, [])
              groups.get(task.repo).push(task)
            }
            return [...groups.entries()].map(([repo, tasks]) => h('div', { key: repo, style: styles.repoSection },
              h('div', { style: styles.repoHeader },
                h('strong', { title: repo }, repo),
                h('span', { style: muted }, `${tasks.filter(item => item.status === 'converged').length}✓ ${tasks.filter(item => item.status === 'failed').length}✗ ${tasks.filter(item => item.latest === null).length}–`),
                h('span', { style: { flex: 1 } }),
                h('button', { style: styles.taskBtn, onClick: () => runRepo(repo) }, 'Run all'),
              ),
              tasks.map(task => {
                const pixels = task.latest?.pixels ?? []
                const average = pixels.length === 0 ? null : pixels.reduce((sum, value) => sum + value, 0) / pixels.length
                const ready = task.status === 'converged' || task.status === 'failed'
                return h('div', { key: task.id, style: styles.taskCard },
                  h('div', { style: styles.taskRow },
                    h('strong', null, task.id),
                    h('span', { style: styles.pill }, task.status),
                    h('span', { style: { ...muted, marginLeft: 'auto' } }, 'single run'),
                  ),
                  h('div', { style: { ...muted, fontSize: 10, paddingTop: 2 } },
                    average === null ? '尚无 run' : `${(average * 100).toFixed(2)}% pixels`,
                  ),
                  h('div', { style: { display: 'flex', gap: 6, paddingTop: 4, flexWrap: 'wrap' } },
                    h('button', { style: { ...styles.taskBtn, opacity: ready ? 1 : 0.5 }, disabled: !ready, onClick: () => { if (ready) showReport(task) } }, 'Report'),
                    task.reportPath === undefined ? null : h('a', { style: { ...styles.taskBtn, textDecoration: 'none' }, href: `/pixel-parity/task/report-file?taskId=${encodeURIComponent(task.id)}`, target: '_blank' }, 'Download'),
                    h('button', { style: { ...styles.taskBtn, color: '#c0392b' }, onClick: () => deleteTaskAction(task) }, state.pendingDelete === task.id ? 'Confirm' : 'Delete'),
                  ),
                )
              }),
            ))
          })(),
          taskCount === 0 ? h('div', { style: { ...styles.taskCard, textAlign: 'center', padding: 18 } },
            h('div', { style: { fontSize: 12, fontWeight: 600 } }, '还没有对齐任务'),
            h('div', { style: { ...muted, fontSize: 10, marginTop: 4 } }, '用 Projects 创建项目，或让模型在对话里直接建。'),
            h('button', { style: { ...styles.taskBtn, marginTop: 10 }, onClick: openProjects }, '打开 Projects'),
          ) : null,
          h('div', { style: styles.logBox },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 } },
              h('strong', { style: { fontSize: 11 } }, 'Plugin log'),
              h('span', { style: { ...muted, fontSize: 10 } }, `${(store.logs ?? []).length} entries`),
              h('span', { style: { flex: 1 } }),
              h('button', { style: styles.iconButton, onClick: loadLogs }, '↻'),
            ),
            (store.logs ?? []).slice(-8).reverse().map((entry, index) => h('div', { key: index, style: styles.logRow },
              h('span', { style: { color: entry.level === 'error' ? '#b91c1c' : '#64748b' } }, entry.at?.slice(11, 19) ?? ''),
              h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: JSON.stringify(entry.data) }, entry.event),
            )),
          ),
          store.message === null ? null : h('div', { style: styles.message }, store.message),
          store.diagnosis === null ? null : h('div', { style: styles.diagnosis },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              h('strong', null, 'diagnose'),
              h('span', { style: styles.pill }, `iter ${store.diagnosis.iteration ?? 1}`),
              h('span', { style: { flex: 1 } }),
              h('button', {
                style: styles.iconButton,
                title: t.close,
                onClick: () => { state.diagnosis = null; notify() },
              }, '×'),
            ),
            (store.diagnosis.viewports ?? []).slice(0, 1).map((viewport, index) => h('div', { key: index, style: { paddingTop: 4 } },
              h('div', { style: { fontWeight: 600 } }, `${viewport.status} ${viewport.case} @ ${viewport.viewport}`),
              (viewport.findings ?? []).slice(0, 3).map((finding, findingIndex) => h('div', {
                key: findingIndex,
                style: { ...muted, paddingTop: 2 },
              }, `[${finding.layer}] ${finding.summary}`)),
              (viewport.next ?? []).length === 0
                ? null
                : h('div', { style: { ...muted, paddingTop: 3 } }, `next: ${viewport.next[0]}`),
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
      },
    }
  },
})












