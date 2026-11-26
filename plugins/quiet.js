// name: 静默心跳
// description: 停掉 vs 自己的计划任务（心跳），这样接下来停宿主时，它不会把 daemon 那一串重新拉起来。挂起会记在磁盘上，干完活跑「解除静默」还回去
// needs: volcano_quiesce_status, volcano_quiesce
const before = await tools.volcano_quiesce_status({})
if (before.suspended) {
  return { already: true, note: '心跳已经是停着的；先跑「解除静默」再重来', live: before.live }
}
if (before.leftover) {
  return {
    stuck: true,
    note: '磁盘上有一个没人还的挂起，而且不是这个服务持有的。先确认任务状态，该开就手动开',
    leftover: before.leftover,
  }
}
const q = await tools.volcano_quiesce({})
return {
  suspended: q.ok,
  was: q.was,
  handlePrefix: q.ok ? q.handle.slice(0, 8) : null,
  why: q.why,
  next: q.ok ? '现在可以停宿主了；处理完跑「解除静默」' : null,
}
