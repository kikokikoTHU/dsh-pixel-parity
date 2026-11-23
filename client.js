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
    const state = { open: false, data: null, tasks: null, error: null, loading: false, repo: storedRepo, message: null, diagnosis: null, viewer: null, pendingDelete: null, projects: null, projectsOpen: false, project: null, projectStep: 1, projectDraft: { repo: '', baseCommit: 'HEAD', config: 'parity.config.mjs', name: '' }, sourceDraft: '', projectBusy: false, creating: false, roundViewer: null }
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

    function ProjectOverlay() {
      const store = useStore()
      if (!store.projectsOpen) return null
      const project = store.project
      const gate = project === null ? null : projectGate(project)
      const close = () => { state.projectsOpen = false; state.project = null; notify() }
      const header = (title, subtitle) => h('div', { style: styles.projectHeader },
        h('div', null,
          h('strong', { style: { fontSize: 13 } }, title),
          subtitle === undefined ? null : h('div', { style: { ...muted, fontSize: 10 } }, subtitle),
        ),
        h('span', { style: { flex: 1 } }),
        h('button', { style: styles.iconButton, onClick: close }, '×'),
      )
      if (project === null) {
        return h('div', { style: styles.projectBackdrop, onClick: close },
          h('div', { style: styles.projectPanel, onClick: event => event.stopPropagation() },
            header('Projects', 'repo + base commit + 设计源，分析与匹配自动执行'),
            h('div', { style: styles.projectBody },
              store.creating
                ? h('div', { style: styles.projectCard },
                    h('strong', null, '新建对齐项目'),
                    h('div', { style: { display: 'grid', gap: 8, marginTop: 10 } },
                      h('input', { style: styles.input, placeholder: '仓库路径，例如 D:\\work\\anubis', value: state.projectDraft.repo, onChange: event => { state.projectDraft.repo = event.target.value; notify() } }),
                      h('input', { style: styles.input, placeholder: '基准 commit（默认 HEAD）', value: state.projectDraft.baseCommit, onChange: event => { state.projectDraft.baseCommit = event.target.value; notify() } }),
                      h('input', { style: styles.input, placeholder: 'parity.config.mjs 路径（相对仓库或绝对）', value: state.projectDraft.config, onChange: event => { state.projectDraft.config = event.target.value; notify() } }),
                      h('input', { style: styles.input, placeholder: '项目名称（可选）', value: state.projectDraft.name, onChange: event => { state.projectDraft.name = event.target.value; notify() } }),
                    ),
                    h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
                      h('button', { style: styles.taskBtn, onClick: () => { state.creating = false; notify() } }, '取消'),
                      h('button', { style: { ...styles.taskBtn, background: '#111827', color: '#fff', borderColor: '#111827' }, disabled: state.projectBusy || state.projectDraft.repo.trim() === '', onClick: createProjectFromDraft }, state.projectBusy ? '…' : '创建项目'),
                    ),
                  )
                : h('div', null,
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('strong', null, '对齐项目'),
                      h('span', { style: { flex: 1 } }),
                      h('button', { style: { ...styles.taskBtn, background: '#111827', color: '#fff', borderColor: '#111827' }, onClick: () => { state.creating = true; notify() } }, '+ 新建项目'),
                    ),
                    h('div', { style: { marginTop: 8 } },
                      (store.projects ?? []).length === 0
                        ? h('div', { style: { ...muted, fontSize: 11 } }, '还没有项目')
                        : (store.projects ?? []).map(item => h('div', {
                            key: item.id,
                            style: styles.projectRow,
                            onClick: () => { state.project = item; state.projectStep = item.subtasks.length === 0 ? 1 : 3; notify() },
                          },
                            h('strong', null, item.name),
                            h('span', { style: styles.pill }, item.status),
                            h('span', { style: { ...muted, marginLeft: 'auto', fontSize: 10 } }, `${item.subtasks.length} subtasks · ${item.rounds.length} rounds`),
                          )),
                    ),
                  ),
            ),
          ),
        )
      }
      const stepOne = h('div', null,
        h('div', { style: styles.projectCard },
          h('strong', null, '1 · 仓库与设计源'),
          h('div', { style: { ...muted, fontSize: 10, marginTop: 2 } }, project.repo),
          h('div', { style: { ...muted, fontSize: 10 } }, `base ${project.baseCommit.slice(0, 7)} · ${project.config}`),
        ),
        h('div', { style: styles.projectCard },
          h('strong', null, '设计源'),
          h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
            h('input', { style: { ...styles.input, flex: 1 }, placeholder: 'https://… 或本地绝对路径', value: state.sourceDraft, onChange: event => { state.sourceDraft = event.target.value; notify() } }),
            h('button', { style: styles.taskBtn, disabled: state.projectBusy, onClick: () => addProjectSource(state.sourceDraft.startsWith('http') ? 'url' : 'file') }, '添加'),
          ),
          h('div', { style: { marginTop: 8 } },
            project.sources.map(source => h('div', { key: source.id, style: styles.projectRow },
              h('span', { style: styles.pill }, source.status),
              h('span', { style: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, source.location),
              h('button', { style: styles.iconButton, title: '删除设计源', onClick: () => removeProjectSource(source.id) }, '×'),
            )),
          ),
        ),
        h('div', { style: styles.projectCard },
          h('strong', null, '2 · 自动分析与匹配'),
          h('div', { style: { ...muted, fontSize: 10, marginTop: 4 } }, gate.reason || '全部分析完成'),
          project.matches.length === 0 ? null : h('div', { style: { marginTop: 6 } },
            project.matches.map(match => h('div', { key: match.sourceId, style: { ...muted, fontSize: 10 } },
              `${match.sourceId} → ${match.caseId} · ${Math.round(match.confidence * 100)}% · ${match.status}`,
            )),
          ),
        ),
      )
      const stepTwo = h('div', null,
        h('div', { style: styles.projectCard },
          h('strong', null, '生成子任务'),
          h('div', { style: { ...muted, fontSize: 10, marginTop: 2 } }, '勾选决定下一轮执行范围'),
          project.subtasks.map(task => h('label', { key: task.id, style: { ...styles.projectRow, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: (project.nextSelection ?? []).includes(task.id), onChange: () => projectToggleSubtask(task.id) }),
            h('span', { style: { fontSize: 11 } }, task.title),
            h('span', { style: styles.pill }, task.needsReview ? '待复核' : `${Math.round(task.confidence * 100)}%`),
          )),
        ),
      )
      const detail = h('div', null,
        h('div', { style: styles.projectCard },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('strong', null, project.name),
            h('span', { style: styles.pill }, project.status),
            h('span', { style: { flex: 1 } }),
            h('button', { style: { ...styles.taskBtn, background: '#111827', color: '#fff', borderColor: '#111827' }, disabled: state.projectBusy || (project.nextSelection ?? []).length === 0, onClick: startProjectRound }, 'Run next round'),
            h('button', { style: { ...styles.taskBtn, color: '#c0392b' }, onClick: deleteCurrentProject }, state.pendingDelete === project.id ? 'Confirm' : 'Delete'),
          ),
          h('div', { style: { ...muted, fontSize: 10, marginTop: 4 } }, `${project.repo} · base ${project.baseCommit.slice(0, 7)}`),
        ),
        h('div', { style: styles.projectCard },
          h('strong', null, '本轮子任务'),
          project.subtasks.map(task => h('label', { key: task.id, style: { ...styles.projectRow, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: (project.nextSelection ?? []).includes(task.id), onChange: () => projectToggleSubtask(task.id) }),
            h('span', { style: { fontSize: 11 } }, task.title),
            task.needsReview ? h('span', { style: styles.pill }, '待复核') : null,
          )),
        ),
        h('div', { style: styles.projectCard },
          h('strong', null, '轮次'),
          project.rounds.length === 0 ? h('div', { style: { ...muted, fontSize: 11, marginTop: 4 } }, '还没有执行过轮次') : null,
          [...project.rounds].reverse().map(round => h('div', { key: round.id, style: styles.projectRow },
            h('strong', null, `Round ${round.number}`),
            h('span', { style: styles.pill }, round.status),
            h('span', { style: { ...muted, fontSize: 10 } }, `${round.selection.length} selected`),
            h('span', { style: { flex: 1 } }),
            round.status === 'completed' ? h('button', { style: styles.taskBtn, onClick: () => openRoundReport(project.id, round.number) }, 'Report') : null,
          )),
        ),
      )
      return h('div', { style: styles.projectBackdrop, onClick: close },
        h('div', { style: styles.projectPanel, onClick: event => event.stopPropagation() },
          header(project.name, `base ${project.baseCommit.slice(0, 7)} · ${project.sources.length} sources`),
          h('div', { style: styles.projectBody },
            h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
              h('button', { style: { ...styles.taskBtn, borderColor: state.projectStep === 1 ? '#111827' : undefined }, onClick: () => { state.projectStep = 1; notify() } }, '1 · 仓库与设计源'),
              h('button', { style: { ...styles.taskBtn, borderColor: state.projectStep === 2 ? '#111827' : undefined, opacity: gate.ready ? 1 : 0.5 }, onClick: () => { if (gate.ready) { state.projectStep = 2; notify() } } }, '2 · 生成子任务'),
              h('button', { style: { ...styles.taskBtn, opacity: project.subtasks.length > 0 ? 1 : 0.5 }, onClick: () => { if (project.subtasks.length > 0) { state.projectStep = 3; notify() } } }, '项目页'),
            ),
            state.projectStep === 1 ? stepOne : state.projectStep === 2 ? stepTwo : detail,
            state.projectStep === 1
              ? h('div', { style: { marginTop: 10, display: 'flex', justifyContent: 'flex-end' } },
                  h('button', {
                    style: { ...styles.taskBtn, background: gate.ready ? '#111827' : '#e2e8f0', color: gate.ready ? '#fff' : '#94a3b8', borderColor: gate.ready ? '#111827' : '#e2e8f0' },
                    disabled: !gate.ready,
                    title: gate.reason,
                    onClick: () => { state.projectStep = 2; notify() },
                  }, gate.ready ? '生成子任务 →' : gate.reason),
                )
              : null,
          ),
          h('div', { style: { padding: '8px 16px', borderTop: '1px solid #eef2f7', display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', { style: styles.taskBtn, onClick: () => { state.project = null; loadProjects(); notify() } }, '← Projects'),
            store.message === null ? null : h('span', { style: { ...muted, fontSize: 10 } }, store.message),
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
        const timer = setInterval(() => { loadTasks() }, 4000)
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
              tasks.map(task => {              }),
            ))
          })(),
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












