// name: 查验
// description: 同一个文件，从几个工程各问一遍——谁在用它（vs）、它是什么格式（torikago）、它是不是一个 PyInstaller 归档（nanodesu，装了才问）
// params: path=
// needs: volcano_entity, torikago_json
const path = String(args.path || '').trim()
if (!path) return { ok: false, note: 'path 是空的——填一个文件的绝对路径' }

// Serial rather than Promise.all. These cross into two other processes, and running them one after
// another means a failure is attributable to the call that failed instead of to whichever settled first.
// A plugin's value is being reliable, not being fast.
const inUse = await tools.volcano_entity({ kind: 'path', id: path })
const format = await tools.torikago_json({ path })

// `needs:` is a hard requirement: without those bindings the page greys this plugin out and it cannot
// run at all. Nanodesu is a *soft* one -- it only answers for PyInstaller archives, so declaring it
// required would grey this plugin out for every other file. Presence is checked at runtime instead.
const hasArchive = typeof tools.nanodesu_info === 'function'
const archive = hasArchive ? await tools.nanodesu_info({ path }) : null

// A non-zero exit puts the reason on stderr and leaves stdout empty. The first version of this plugin
// carried only `text`, so nanodesu answering "this is not an archive" arrived as `ok: false` with
// nothing beside it -- a silent failure, which is the one thing this tool keeps removing. Both streams
// are kept now, and `undefined` never appears: one such field would make the whole result invalid.
const external = (r) => {
  const part = { ok: r.ok, exitCode: r.exitCode, ms: r.ms }
  if (r.json) {
    part.json = r.json
    return part
  }
  part.text = String(r.text || '').slice(0, 2000)
  if (r.stderr) part.stderr = String(r.stderr).slice(0, 1000)
  return part
}

const formatPart = external(format)
const archivePart = archive === null
  ? { asked: false, why: 'nanodesu bindings are not loaded, so the archive question was not asked' }
  : { asked: true, ...external(archive) }

return { path, inUse, format: formatPart, archive: archivePart }
