// name: uv 缓存
// description: 一次 uv cache prune 会拿掉什么、能省多少。只出计划，不删任何东西
const plan = await tools.volcano_cache_plan({ keep: 1 })
return { plan }
