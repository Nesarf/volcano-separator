// name: 心跳
// description: 一个按钮，两个方向。心跳还着就停掉它（为停宿主做准备），停着就还回去——方向由当前状态决定，不需要先判断再点
// needs: volcano_quiesce, volcano_resume, volcano_quiesce_status
const s = await tools.volcano_quiesce_status({})

if (s.live) {
  const r = await tools.volcano_resume({ handle: s.live.handle })
  return {
    action: 'resumed',
    ok: r.ok,
    restored: r.restored,
    changed: r.changed,
    why: r.why,
    stillSuspended: r.stillSuspended,
    note: r.ok ? '心跳回来了，恢复到它本来那个状态' : '没能还回去，挂起还留在磁盘上',
  }
}

if (s.leftover) {
  return {
    action: 'none',
    stuck: true,
    leftover: s.leftover,
    note: '磁盘上有一个没人还的挂起，但这个服务不持有它。volcano_resume 还不了它——看任务状态，该开就手动开',
  }
}

const q = await tools.volcano_quiesce({})
return {
  action: 'suspended',
  ok: q.ok,
  was: q.was,
  handlePrefix: q.ok ? q.handle.slice(0, 8) : null,
  why: q.why,
  note: q.ok ? '心跳停了，现在可以停宿主；处理完再点一次这个按钮还回去' : '没能停掉',
}
