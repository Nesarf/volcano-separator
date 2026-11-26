// name: 宿主
// description: DSH 宿主（3080）现在是谁在听、从哪个路径跑；顺带看一眼 9077 上的 daemon
const host = await tools.volcano_entity({ kind: 'port', id: '3080' })
const daemon = await tools.volcano_entity({ kind: 'port', id: '9077' })
return { host, daemon }
