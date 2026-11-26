// name: 问一句
// description: 就这台机器的某个问题，让模型给一句人话的答案。它会花钱、会把问题发出去，所以只有服务带 --allow-llm 时才出现
// params: prompt=
// needs: vos_ask
const prompt = String(args.prompt || '').trim()
if (!prompt) return { ok: false, note: 'prompt 是空的——写一句要问的' }

const a = await tools.vos_ask({ prompt })

// Shaped conditionally rather than filled with holes: one `undefined` field anywhere in the returned
// object turns the whole result into `invalid-output`, which this plugin would then cause by doing
// nothing wrong. `null` is legal JSON; `undefined` is not.
const answered = a.ok
  ? { ok: true, model: a.model, requested: a.requested, ms: a.ms, usage: a.usage ?? null, text: a.text }
  : { ok: false, kind: a.kind, why: a.why, ms: a.ms }

return { prompt, key: a.askedBy ?? null, ...answered }
