// name: 端口
// description: 一个端口现在是谁在听、从哪个路径跑的。默认问 3080（DSH 宿主）
// params: port=3080
// needs: volcano_entity
const port = String(args.port || '3080').trim()
if (!port) return { ok: false, note: 'port 是空的' }
const found = await tools.volcano_entity({ kind: 'port', id: port })
return { port, entity: found }
