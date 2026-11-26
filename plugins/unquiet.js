// name: 解除静默
// description: 把「静默心跳」留下的挂起还回去，恢复它当时的状态——本来就停着的话，仍然是停着
// needs: volcano_quiesce_status, volcano_resume
const s = await tools.volcano_quiesce_status({})
if (!s.live) {
  if (s.leftover) {
    return {
      stuck: true,
      note: '这个挂起不是当前服务持有的：上一个进程没还就走了。volcano_resume 还不了它，只能看任务状态、手动开回来',
      leftover: s.leftover,
    }
  }
  return { nothing: true, note: '没有挂起的心跳' }
}
const r = await tools.volcano_resume({ handle: s.live.handle })
return { resumed: r.ok, restored: r.restored, changed: r.changed, why: r.why, stillSuspended: r.stillSuspended }
