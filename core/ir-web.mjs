/**
 * IR → static HTML renderer.
 *
 * v1 renders every node as an absolutely positioned box in page coordinates.
 * It is intentionally literal: the goal is to prove the IR keeps enough
 * information to reproduce the captured screen, not to produce maintainable
 * markup. A later generator emits semantic HTML/CSS or QML.
 */

import { expandStyle, flattenIr } from './ir.mjs'

/**
 * Render an IR document as a standalone HTML page.
 * @param {object} ir - IR document.
 * @returns {string} HTML source.
 */
export function generateHtml(ir) {
  const flattened = flattenIr(ir.root)
  const viewport = ir.source.viewport
  const boxes = flattened.map(node => {
    const style = expandStyle(node.style, ir.tokens)
    const declarations = [
      'position:absolute',
      'box-sizing:border-box',
      `left:${node.box.x}px`,
      `top:${node.box.y}px`,
      `width:${node.box.w}px`,
      `height:${node.box.h}px`,
      'overflow:hidden',
    ]
    for (const [property, value] of Object.entries(style)) {
      if (value === undefined || value === '') continue
      // The generated page is an absolute layout: a captured `position: static`
      // must not override the `position: absolute` written above.
      if (property === 'position') continue
      // Boxes are captured as border-box rectangles; forcing border-box keeps the
      // pinned width/height equal to the measured size.
      if (property === 'boxSizing') continue
      // Offsets are derived from the captured box, not from the computed style.
      if (property === 'top' || property === 'left' || property === 'right' || property === 'bottom') continue
      // Text is rendered from measured runs, not from the element's own box.
      if (property === 'textAlign') continue
      if (property.startsWith('margin')) continue
      declarations.push(`${kebab(property)}:${value}`)
      if (property.endsWith('Width') && property.startsWith('border') && parseFloat(value) > 0) {
        declarations.push(`${kebab(property.replace('Width', 'Style'))}:solid`)
      }
    }
    return `<div data-ir="${escapeHtml(node.id)}" style="${escapeHtml(declarations.join(';'))}"></div>`
  })

  const runs = []
  for (const node of flattened) {
    if (node.textRuns === undefined || node.textRuns.length === 0) continue
    const style = expandStyle(node.style, ir.tokens)
    for (const run of node.textRuns) {
      const declarations = [
        'position:absolute',
        'box-sizing:border-box',
        `left:${run.box.x}px`,
        `top:${run.box.y}px`,
        `width:${run.box.w}px`,
        `height:${run.box.h}px`,
        `line-height:${run.box.h}px`,
        'white-space:pre',
        'overflow:hidden',
      ]
      if (style.fontFamily !== undefined) declarations.push(`font-family:${style.fontFamily}`)
      if (style.fontSize !== undefined) declarations.push(`font-size:${style.fontSize}`)
      if (style.fontWeight !== undefined) declarations.push(`font-weight:${style.fontWeight}`)
      if (style.letterSpacing !== undefined) declarations.push(`letter-spacing:${style.letterSpacing}`)
      if (style.color !== undefined) declarations.push(`color:${style.color}`)
      runs.push(`<span data-ir-run="${escapeHtml(node.id)}" style="${escapeHtml(declarations.join(';'))}">${escapeHtml(run.text)}</span>`)
    }
  }

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>IR render</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { position: relative; width: ${viewport.width}px; height: ${viewport.height}px; }
</style>
</head>
<body>
${boxes.join('\n')}
${runs.join('\n')}
</body>
</html>
`
}

function kebab(property) {
  return property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
