// name: 证据
// description: 积累下来的反事实——每天有多少发现——以及最近十四天里有哪些保管决定
const evidence = await tools.volcano_evidence({})
const timeline = await tools.volcano_timeline({ days: 14 })
return { evidence, timeline }
