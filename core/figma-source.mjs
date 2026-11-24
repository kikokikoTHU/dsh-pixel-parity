/**
 * Figma source parsing: design URL -> API node payload -> unified IR.
 *
 * A Figma personal access token is required. The token is read from the
 * `token` argument or `FIGMA_TOKEN`; it is never written to disk or logs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { figmaToIr } from './figma.mjs'
import { flattenIr } from './ir.mjs'

export function parseFigmaUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error('invalid Figma URL')
  }
  const match = url.pathname.match(/\/(?:design|file)\/([A-Za-z0-9]+)/)
  if (match === null) throw new Error('Figma URL must contain /design/<fileKey> or /file/<fileKey>')
  const fileKey = match[1]
  const rawNode = url.searchParams.get('node-id')
  if (rawNode === null || rawNode.length === 0) throw new Error('Figma URL is missing ?node-id=...')
  const nodeId = rawNode.replace('-', ':')
  return { fileKey, nodeId, url: url.href }
}

export async function fetchFigmaNode({ fileKey, nodeId, token, apiBase = 'https://api.figma.com', timeoutMs = 30000 }) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('FIGMA_TOKEN is not set; pass token or export a Figma personal access token')
  }
  const endpoint = `${apiBase.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
  const response = await fetch(endpoint, {
    headers: { 'X-Figma-Token': token },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Figma API ${response.status}${detail.length === 0 ? '' : `: ${detail.slice(0, 300)}`}`)
  }
  const payload = await response.json()
  if (payload?.err !== undefined) throw new Error(`Figma API error: ${String(payload.err)}`)
  return payload
}

export function summarizeIr(ir) {
  const nodes = flattenIr(ir.root ?? ir)
  const texts = nodes.filter(node => Array.isArray(node.textRuns) && node.textRuns.length > 0)
  return {
    viewport: ir.source?.viewport ?? null,
    nodes: nodes.length,
    texts: texts.length,
    root: nodes[0]?.tag ?? null,
    sampleTexts: texts.slice(0, 8).map(node => node.textRuns[0].text),
  }
}

/**
 * Parse one Figma link into the unified IR and persist it.
 * Returns { ir, path, summary, fileKey, nodeId }.
 */
export async function parseFigmaLink(input) {
  const parsed = parseFigmaUrl(input.url)
  const token = input.token ?? process.env.FIGMA_TOKEN
  const payload = await fetchFigmaNode({ ...parsed, token, apiBase: input.apiBase })
  const ir = figmaToIr(payload, { fileKey: parsed.fileKey, nodeId: parsed.nodeId })
  const output = input.output === undefined
    ? resolve(process.cwd(), '.parity', 'figma', `${parsed.fileKey}-${parsed.nodeId.replace(':', '-')}.json`)
    : resolve(isAbsolute(input.output) ? input.output : process.cwd(), input.output)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(ir, null, 2)}\n`)
  return { ir, path: output, summary: summarizeIr(ir), ...parsed }
}

/** Parse a local Figma JSON export (nodes payload or a bare document node). */
export function parseFigmaFile(input) {
  const path = resolve(input.path)
  if (!existsSync(path)) throw new Error(`Figma JSON not found: ${path}`)
  const payload = JSON.parse(readFileSync(path, 'utf8'))
  const nodeId = input.nodeId
  const ir = figmaToIr(payload, { nodeId })
  const output = input.output === undefined
    ? resolve(dirname(path), `${path.split(/[\\/]/).pop().replace(/\.json$/i, '')}.ir.json`)
    : resolve(isAbsolute(input.output) ? input.output : process.cwd(), input.output)
  writeFileSync(output, `${JSON.stringify(ir, null, 2)}\n`)
  return { ir, path: output, summary: summarizeIr(ir) }
}

