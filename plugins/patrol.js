// name: 巡检
// description: 一次拿到服务的整体情况：uv 工具链、daemon 端口、Postgres、看门狗任务，再附一张历史启动失败的表
const status = await tools.volcano_status({})
const doctor = await tools.volcano_doctor({})
return { status, doctor }
