// name: 信号
// description: 最近四小时里有没有像隐蔽行为的东西，以及按现行策略会怎么处置它们
const found = await tools.volcano_signals({ minutes: 240 })
const verdicts = await tools.volcano_decide({ minutes: 240 })
return { found, verdicts }
