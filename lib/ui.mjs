/**
 * The page this tool serves at `/`: load `ui/page.html`, fill in the palette and the binding list.
 *
 * Where the look comes from
 * -------------------------
 * Not from taste, and not from a second palette: `bin/panel.json` is the same file the chamber's
 * window draws with -- nine roles, a bevel rule, a 716x385 console tier -- read here at request
 * time. One palette with two consumers cannot drift, and a colour changed for the window changes the
 * page in the same commit. The pixel-art constraint this project has carried since 2026-10-06
 * applies to every surface, so a web page is not an exception to it.
 *
 * Why the markup is a file
 * ------------------------
 * It was a template literal here first, and it made this module 200 lines of string in which the
 * real code -- palette resolution, escaping, list building -- was harder to find than the HTML. The
 * markup also reached the repository's import checker as text it had to strip, and text that dense
 * is where a stripper loses track. A resource file is the honest shape: it can be opened in an
 * editor or a browser directly, and this module goes back to being code.
 *
 * What the page does not do
 * -------------------------
 * It does not call anything on load. A page that runs a tool when opened is a page that changes the
 * machine when somebody refreshes by accident, and the disk scan behind one of these tools is not
 * free.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_ROOT } from './platform.mjs'

const PANEL = join(CORE_ROOT, 'bin', 'panel.json')
const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'ui', 'page.html')

/** CSS variable name -> role key in panel.json. The order is the one the window draws in. */
const ROLES = [
  ['frame-dark', 'fd', '#181620'],
  ['frame-light', 'fl', '#605880'],
  ['title', 'ta', '#342C48'],
  ['title-text', 'tx', '#E8E4F4'],
  ['well', 'wl', '#242030'],
  ['content', 'ct', '#3C3454'],
  ['content-text', 'cx', '#D4CEE8'],
  ['close', 'cm', '#D04858'],
  ['inactive', 'ti', '#1E1B28'],
]

/**
 * The nine roles, as hex, or a readable refusal. A page rendered with guessed colours would be the
 * false-signal pattern this project removes, so the failure is shown rather than papered over.
 */
export function loadPalette() {
  try {
    const panel = JSON.parse(readFileSync(PANEL, 'utf8'))
    const hex = {}
    for (const [key, rgba] of Object.entries(panel.colours ?? {})) {
      hex[key] = '#' + [rgba[0], rgba[1], rgba[2]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    }
    return { hex, size: panel.size ?? [716, 385], source: 'bin/panel.json', readable: true }
  } catch (e) {
    return { hex: {}, size: [716, 385], source: 'bin/panel.json', readable: false, why: String(e?.message ?? e) }
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/**
 * The first sentence of a description, for a hover title.
 *
 * A tooltip is one unwrapped line, and several of these descriptions run past five hundred characters —
 * `volcano_entity` alone explains three kinds of question. Rendered whole, that is a strip of text wider
 * than the window, which is worse than no tooltip at all.
 *
 * Nothing is lost by shortening it here: the full text still comes back from `GET /ptc/bindings`, which
 * is where a caller that wants to read it should be looking anyway. This is the display layer cutting
 * what the protocol keeps.
 */
function brief(text, limit = 140) {
  const s = String(text ?? '').trim()
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' -- '), cut.lastIndexOf('。'))
  return (stop > 40 ? cut.slice(0, stop) : cut).trim() + '…'
}

/**
 * The document. Tools and the denied list are rendered into the markup rather than into a script, so
 * the client reads them from the DOM instead of from interpolated JavaScript. The token is the one
 * value that goes into an attribute for the same reason: a script literal would have to be built by
 * string concatenation, and a token spliced into JavaScript is a quoting bug waiting for a value that
 * contains a quote.
 */
export function renderPage({ port, tools = [], denied = [], palette = loadPalette(), version = 'unknown', token = '', plugins = [], heartbeat = null } = {}) {
  const vars = ROLES.map(([name, key, fallback]) => '  --' + name + ': ' + (palette.hex[key] ?? fallback) + ';').join('\n')
  const items = tools
    .map((t) => '<li data-name="' + esc(t.name) + '" title="' + esc(brief(t.description)) + '">' + esc(t.name) + '</li>')
    .join('')
  const deniedItems = denied.map((n) => '<li class="denied" data-name="' + esc(n) + '">' + esc(n) + '</li>').join('')
  // A plugin that cannot run says why in its title rather than disappearing: an absent entry reads as a
  // broken tool, while a greyed one with "needs volcano_quiesce" reads as a switch nobody turned on.
  //
  // The parameter boxes are rendered next to the name instead of behind a click, because a plugin with
  // one argument should take one glance to use. They are inputs, not part of the click target: the
  // script skips a click that landed on one, so typing a port does not run anything.
  const pluginItems = plugins.length
    ? plugins
        .map((p) => {
          const title = p.runnable ? p.description : (p.description ? p.description + ' -- ' : '') + 'needs ' + p.missing.join(', ')
          const disabled = p.runnable ? '' : ' disabled'
          const fields = (p.params ?? [])
            .map(
              (f) =>
                '<input class="param" data-param="' + esc(f.name) + '" value="' + esc(f.default) +
                '" placeholder="' + esc(f.name) + '" size="' + String(Math.max(4, Math.min(24, String(f.default).length + 2))) + '"' + disabled + '>',
            )
            .join('')
          return (
            '<li class="plugin' + (p.runnable ? '' : ' disabled') + '" data-id="' + esc(p.id) +
            '" data-runnable="' + (p.runnable ? '1' : '0') + '"' +
            (p.confirm ? ' data-confirm="' + esc(p.confirm) + '"' : '') +
            ' title="' + esc(title) + '">' +
            '<span class="pname">' + esc(p.name) + '</span>' + fields + '</li>'
          )
        })
        .join('')
    : '<li class="empty">no plugins loaded (start with --plugins DIR)</li>'
  // `<` is escaped because this JSON sits inside a script element: the only sequence that ends one early
  // is `</script`, and escaping the character is cheaper than reasoning about whether a plugin contains it.
  const pluginData = JSON.stringify(plugins.map((p) => ({ id: p.id, name: p.name, runnable: p.runnable, program: p.program }))).replace(/</g, '\\u003c')
  // Read from the live gate at render time, so the strip does not claim "running" while this very
  // server is holding the task disabled. `null` means the capability is off, and says nothing.
  const heartbeatText = heartbeat === null ? '' : heartbeat ? 'heartbeat: suspended' : 'heartbeat: running'
  const warn = palette.readable
    ? ''
    : '<p class="warn">palette unreadable: ' + esc(palette.why ?? '') + '</p>'

  return readFileSync(PAGE, 'utf8')
    .replace('/*PALETTE_VARS*/', vars)
    .replace('<!--PALETTE_WARN-->', warn)
    .replace('<!--TOOLS-->', items)
    .replace('<!--DENIED-->', deniedItems)
    .replace('<!--PLUGINS-->', pluginItems)
    .replace('<!--PLUGIN_DATA-->', pluginData)
    .replace('{{HEARTBEAT}}', esc(heartbeatText))
    .replace('{{DENIED_COUNT}}', String(denied.length))
    .replace('{{PORT}}', esc(port))
    .replace('{{VERSION}}', esc(version))
    .replace('{{TOKEN}}', esc(token))
}
