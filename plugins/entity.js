// name: 实体
// description: 问一个 pid、一个路径或一个端口：它是什么、从哪个路径跑的、谁在用它
// params: kind=pid, id=
// needs: volcano_entity
const kind = String(args.kind || 'pid').trim()
const id = String(args.id || '').trim()
if (!id) return { ok: false, note: 'id 是空的——填一个 pid 号、一个路径或一个端口号' }
if (kind !== 'pid' && kind !== 'path' && kind !== 'port') return { ok: false, note: 'kind 只能是 pid、path 或 port' }
const found = await tools.volcano_entity({ kind, id })
return { kind, id, entity: found }
