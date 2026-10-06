import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import { readJsonLoose } from './platform.mjs'

/**
 * What is being supervised, as a value instead of as assumptions spread through the code.
 *
 * Why this file exists
 * --------------------
 * Every path in `resolveContext` used to be built from a literal `~/.hindsight`, the daemon's module
 * name was written into four `uvx --with` lines, and "is it healthy" meant `GET /health` because that
 * is what this particular service answers. None of that was wrong -- it was unexamined. The tool
 * could only describe one shape of thing, so "what is being supervised" was a fact about the source
 * code rather than something anyone could read, disagree with, or replace.
 *
 * That is the same failure this project keeps finding in smaller places, and the pattern for fixing
 * it already exists here: `pgMode` and `deployment` were made explicit as two orthogonal questions
 * rather than one guess. A descriptor is that, one level up.
 *
 * What a descriptor has to answer
 * -------------------------------
 *   1. How do you run it, and under what runtime?
 *   2. Where does its state live, and what are its files called?
 *   3. How do you ask whether it is alive?
 *   4. How do you ask whether it is *ready*? (Different question, and the difference is the whole
 *      reason `probeDaemon` splits liveness from readiness.)
 *   5. What data does it depend on, and how do you ask that thing a real question?
 *
 * What a descriptor may NOT do
 * ----------------------------
 * It may not weaken a probe into a weaker claim. `kind: 'http-json'` names an endpoint and a status;
 * it is not a licence to say "something is listening". The database side already insists on asking a
 * real question (`SELECT 1`), and a descriptor that could only say "the port is open" would be a way
 * of declaring weaker evidence as acceptable. If a service cannot answer a real question, its
 * descriptor says so explicitly rather than quietly agreeing to less.
 *
 * The honesty rules are not per-service either. `unknown != zero`, "refuse rather than silently fall
 * back", "a record must not claim what did not happen" hold for every descriptor in this file, and
 * nothing here can opt out of them.
 */

/** The service this tool was built around. Reproduces the previous hardcoded behaviour exactly. */
export const HINDSIGHT = {
  id: 'hindsight',
  label: 'Hindsight',
  /**
   * The daemon is launched through uvx, so the descriptor names the module and the packages that go
   * with it. `hindsight-embed` used to be written into four separate argument lists in supervisor.mjs;
   * it is one string here.
   */
  runtime: {
    kind: 'uvx',
    module: 'hindsight-embed',
    /** Resolved from the plugin's own config at context time, so this is a placeholder. */
    /**
     * Which config the module version comes from. `resolveContext` has already resolved it onto
     * `ctx.embedVersion`, so that is the primary source; the nested lookup is the fallback for a
     * caller that built a context by hand. Named `pluginCfg` and not `pluginConfig` -- the first
     * version of this said the latter, which resolves to undefined, and its only symptom would have
     * been every command refusing to build a command line.
     */
    versionFrom: 'pluginCfg',
    packages: ['pg0-embedded'],
    /** `uvx --with <module>@<version> daemon --profile <profile> <sub>` */
    subcommand: ['daemon', '--profile', '{profile}'],
  },
  /**
   * The directory shape, with `{home}` and `{profile}` substituted. These are the literals that were
   * spread through resolveContext, collected so that a different service is a different block and not
   * a set of edits.
   */
  layout: {
    home: {
      default: '~/.hindsight',
      env: ['HINDSIGHT_HOME'],
    },
    /** The plugin's own settings file. Note: a fixed name, not `<profile>.json` -- the file is the
     *  plugin's, and the profile inside it selects the service instance. */
    configFile: '{home}/coding-agent.json',
    profileDir: '{home}/profiles',
    daemonLog: '{home}/daemon.log',
    profileEnv: '{home}/profiles/{profile}.env',
    profileLog: '{home}/profiles/{profile}.log',
    profileLock: '{home}/profiles/{profile}.lock',
    /**
     * The embedded database instance: a pg0 instance under the USER's home, named after the runtime
     * module and the profile. It uses `{userHome}`, not `{home}` -- the service's own home is
     * `~/.hindsight`, and this instance is not under it. The first version of this line wrote
     * `{home}/../pg0`, which resolves to the user's home with the dot missing; the real location was
     * taken from `pgDataLocation`, which is where the fact actually lived.
     *
     * The instance-name pattern is a template rather than something derived, so a service whose
     * instance is named differently can say so instead of being renamed to fit.
     */
    dataDir: '{userHome}/.pg0/instances/{instanceName}/data',
    instanceName: '{module}-{profile}',
  },
  health: {
    /** Readiness: the process answered AND its dependencies are usable. */
    ready: { kind: 'http-json', portFrom: 'port', path: '/health', okWhen: 'http-2xx' },
    /** Liveness: the process answered, nothing about its dependencies. */
    live: { kind: 'http-json', portFrom: 'port', path: '/health/live', okWhen: 'http-2xx' },
    /** The log the daemon writes its own errors to. */
    log: { kind: 'file', pathFrom: 'daemonLogFile', errorPatterns: ['error', 'Traceback', 'TimeoutError'] },
    /** How to tell a running daemon from a stale entry when deciding what to stop. */
    identifyBy: { imageNames: ['uvx', 'hindsight-embed', 'hindsight-api', 'python'], mustName: ['hindsight', '9077'] },
  },
  data: {
    kind: 'postgres',
    /** How to ask it a real question. Not "is the port open" -- see the note at the top. */
    probe: { kind: 'sql', statement: 'SELECT 1' },
    /** Embedded installs name the database after the profile; a declared one says so itself. */
    defaultDatabase: 'hindsight',
    user: 'hindsight',
    passwordEnv: 'HINDSIGHT_DB_PASSWORD',
  },
  /** Settings the plugin keeps that this tool reads rather than owns. */
  pluginConfigKeys: ['embedVersion', 'serverMode', 'bankId', 'daemonIdleTimeout'],
}

/**
 * A second service, and the reason it is this one: it is real, it is running on this machine right
 * now, and it is shaped differently enough to actually test the design. A descriptor invented to fit
 * the fields proves the fields are self-consistent and nothing else.
 *
 * What it broke, all of it found by trying to describe it rather than by reasoning about it:
 *
 *   1. **A service with no health endpoint.** DSH answers 404 to `/health`, and 401 to `/api/health`
 *      because a browser-trust fence guards it. "Liveness is an endpoint returning 2xx" is therefore
 *      not a general truth -- for this service, *reachability* is the honest liveness claim, and the
 *      descriptor says `reachable` rather than pretending to a readiness answer it does not have.
 *   2. **A launcher that is not uvx.** It is a plain `node <entry> web`. The runtime block was
 *      written around uvx because that was the only one there was.
 *   3. **A state directory named by an environment variable**, `DSH_HOME`, at the level of the home
 *      itself -- where the Hindsight descriptor had its env override. The layout resolver assumed the
 *      override only existed for `home`, which was true only because there was one descriptor.
 *
 * What it did not break, which is the part that says something: the layout templates, the profile
 * naming, the log declaration and the process-identification block all carried over unchanged. Seven
 * faces were collected and four of them needed no new shape.
 *
 * What it also exposed, honestly: **the operations are not general even though the descriptor is.**
 * `heal`, `warm` and `serve` are Hindsight's sequence, so the CLI refuses them for this service rather
 * than running the wrong tooling against it. The descriptor turned out to be the easy half.
 */
export const DSH = {
  id: 'dsh',
  label: 'DeepSeek Harness host',
  runtime: {
    kind: 'node',
    module: 'dsh',
    versionFrom: null,
    packages: [],
    /** `node <entry> web` -- no module specifier, no profile flag. */
    subcommand: ['web'],
    profileFlag: null,
    /**
     * **This tool cannot start this service, and says so instead of guessing.**
     *
     * The entry point is `E:\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js` on this machine, and
     * it is not written anywhere the tool can read: `settings.yaml` holds UI and agent configuration
     * and no path at all. The first version of this descriptor declared `entryFrom: 'dshEntry'`,
     * which named a config key that does not exist -- the same mistake as `versionFrom:
     * 'pluginConfig'`, made an hour after that one, which is worth recording because it shows how
     * natural the mistake is.
     *
     * A descriptor that can describe a service without being able to launch it is a real category,
     * not a failure: observing, probing and reporting all work here. Pretending to a launch path that
     * would resolve correctly on one machine and wrongly on the next is the alternative, and it is
     * worse than an honest refusal.
     */
    launchable: false,
    launchableWhy: 'the entry point is decided by the install location and is not recorded in any file this tool reads',
  },
  layout: {
    home: { default: '~/.dsh-home', env: ['DSH_HOME'] },
    /** The settings file, read for the entry path. */
    configFile: '{home}/settings.yaml',
    profileDir: '{home}/profiles',
    daemonLog: '{home}/profiles/web/host.log',
    profileEnv: '{home}/profiles/{profile}/cordis.patch.yml',
    profileLog: '{home}/profiles/{profile}/cordis.yml',
    profileLock: '{home}/profiles/{profile}/.lock',
    /** No database, so no instance directory. Deliberately absent rather than pointed at nothing. */
  },
  health: {
    /**
     * `reachable`: the port answers HTTP at all. Not 2xx -- this service answers 401 to a guarded
     * endpoint and 404 to an unguarded one, and both of those mean the process is up and serving.
     * Reading 401 as "unhealthy" would report a working host as down, which is the failure mode this
     * whole tool exists to remove.
     */
    live: { kind: 'any-http-answer', portFrom: 'port', path: '/', okWhen: 'any-http-answer' },
    /**
     * There is no readiness endpoint to point at. Not an omission to be filled in later by guessing:
     * the descriptor says `none`, and a caller asking for readiness gets "this service does not
     * publish one" rather than a 404 read as a failure.
     */
    ready: { kind: 'none', why: 'the host publishes no readiness endpoint; /api/* is guarded by a browser-trust fence and answers 401' },
    log: { kind: 'file', pathFrom: 'daemonLogFile', errorPatterns: ['error', 'Error', 'EADDRINUSE'] },
    identifyBy: { imageNames: ['node'], mustName: ['dsh', 'web'] },
  },
  /** No data layer. Absent, not empty: `dataProbe` returns null and callers must handle that. */
  pluginConfigKeys: [],
}

/** Every descriptor this build knows. */
export const SERVICE_DESCRIPTORS = {
  [HINDSIGHT.id]: HINDSIGHT,
  [DSH.id]: DSH,
}

export const DEFAULT_SERVICE_ID = HINDSIGHT.id

/** Resolve the one that applies: an explicit id, then an id in the loaded config, then the default. */
export function resolveServiceDescriptor(cfg = {}) {
  const id = cfg.service ?? cfg.serviceId ?? DEFAULT_SERVICE_ID
  const d = SERVICE_DESCRIPTORS[id]
  if (!d) {
    // Not a silent fallback to Hindsight. A descriptor that cannot be found is an answer the caller
    // has to see, because running the wrong service's commands is worse than running none.
    return { ok: false, id, detail: `no service descriptor named '${id}' (have: ${Object.keys(SERVICE_DESCRIPTORS).join(', ')})` }
  }
  return { ok: true, id, descriptor: d }
}

/** Expand `~`, then `{home}`, `{profile}`, `{module}`. Order matters: home first, since the others
 *  can appear inside it. */
export function expandPath(template, vars = {}) {
  let p = String(template ?? '')
  if (p === '~') p = vars.home ?? homedir()
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = join(vars.home ?? homedir(), p.slice(2))
  for (const [k, v] of Object.entries(vars)) {
    p = p.split('{' + k + '}').join(String(v ?? ''))
  }
  return resolve(p)
}

/**
 * The service's directory and file paths, resolved against a config.
 *
 * Returns the same key names `resolveContext` used to build by hand, so callers do not change: this
 * is an extraction, not a redesign. A second descriptor is what will test whether the keys are enough.
 */
export function resolveServicePaths(descriptor, cfg = {}) {
  const requested = cfg.profile ?? null
  const L = descriptor.layout
  const userHome = homedir()
  const envOf = (spec) => (spec?.env ?? [])
    .map((e) => process.env[e])
    .find((v) => typeof v === 'string' && v.length > 0)

  const envHome = envOf(L.home)
  const home = resolve(envHome ?? L.home.default.replace(/^~/, userHome))

  // Every sub-path may carry its own environment override, in the same shape as `home` does. DSH's
  // home comes from `DSH_HOME` at the top level, and the first version of this resolver only looked
  // for an override there -- true only because there had been one descriptor.
  const resolveMaybe = (spec, vars) => {
    if (!spec) return null
    const template = typeof spec === 'string'
      ? spec
      : (envOf(spec) ? String(envOf(spec)) : spec.default)
    return template ? expandPath(template, vars) : null
  }

  const configFile = cfg.serviceConfigFile ?? resolveMaybe(L.configFile, { home, userHome })

  // The service's own settings, read before the profile is known, because the profile can come from a
  // command-line flag while other settings can only come from here.
  //
  // Guarded, because a descriptor's config file is not necessarily JSON. `readJsonLoose` tolerates a
  // BOM and throws on anything else -- it does not return null for malformed content, which its name
  // invites a caller to assume. DSH's settings file is YAML, so the unguarded call crashed on the
  // second descriptor and on nothing before it: a shape that had been assumed rather than stated.
  let pluginCfg = {}
  if (configFile && existsSync(configFile)) {
    let parsed = null
    try {
      parsed = readJsonLoose(configFile)
    } catch {
      // Not JSON. This tool reads one settings file to learn a version, and a service whose settings
      // are YAML simply does not offer that here; the descriptor says what it can and cannot know.
      parsed = null
    }
    if (parsed && typeof parsed === 'object') pluginCfg = parsed
  }

  const profile = requested ?? cfg.defaultProfile ?? 'coding-agent'
  const moduleName = descriptor.runtime.module
  const instancePattern = L.instanceName ?? '{module}-{profile}'
  const vars = {
    home,
    userHome,
    profile,
    module: moduleName,
    instanceName: instancePattern.split('{module}').join(moduleName).split('{profile}').join(profile),
  }

  return {
    serviceId: descriptor.id,
    serviceLabel: descriptor.label,
    configFile,
    pluginCfg,
    serviceHome: home,
    // Kept under the old names as well: `hindsightHome` is read by callers and by tests, and an
    // extraction that renamed things would be a redesign wearing an extraction's clothes.
    hindsightHome: home,
    profile,
    profileDir: resolveMaybe(L.profileDir, vars),
    profileEnvFile: resolveMaybe(L.profileEnv, vars),
    profileLogFile: resolveMaybe(L.profileLog, vars),
    profileLockFile: resolveMaybe(L.profileLock, vars),
    daemonLogFile: resolveMaybe(L.daemonLog, vars),
    // Null for a service with no data layer, rather than a path to nothing. A caller that expects a
    // directory here has to see the absence.
    dataDir: resolveMaybe(L.dataDir, vars),
    runtimeModule: moduleName,
  }
}

/**
 * The arguments that launch the service.
 *
 * One function, where four argument lists used to spell the module name out separately. The
 * descriptor supplies the subcommand; the caller still supplies the verbosity flags, because those
 * are about uv and not about the service.
 */
export function serviceArgs(descriptor, ctx, { uvArgs = [], sub = null, offline = false } = {}) {
  const rt = descriptor.runtime
  // Named uvArgs, not uvFlags: `uvFlags` is a function supervisor.mjs exports, and an option sharing
  // that name is read by the import lint as a reference to it.
  const args = [...uvArgs]

  // A descriptor may say it cannot launch its service, and that is an answer, not a failure. DSH's
  // entry point is decided by the install location and is recorded nowhere this tool reads; a guessed
  // path would resolve on one machine and not the next, which is worse than a refusal.
  if (rt.launchable === false) {
    return { ok: false, refused: true, detail: `this tool cannot start ${descriptor.id}: ${rt.launchableWhy ?? 'its descriptor does not declare how'}` }
  }

  if (rt.kind === 'uvx') {
    const version = ctx.embedVersion ?? (rt.versionFrom ? ctx[rt.versionFrom]?.embedVersion : null) ?? null
    if (!version) {
      return { ok: false, detail: `cannot build the command line: no version is known for ${descriptor.id}` }
    }
    if (offline) args.push('--offline')
    args.push('--with', ...(ctx.withPackages ?? rt.packages), `${rt.module}@${version}`)
  } else if (rt.kind === 'node') {
    // A plain interpreter and an entry path. The entry is the caller's to supply, because a
    // descriptor that does not know it must not invent one.
    const entry = ctx.serviceEntry ?? null
    if (!entry) {
      return { ok: false, refused: true, detail: `cannot build the command line for ${descriptor.id}: the entry point is not known` }
    }
    args.push(entry)
  } else {
    return { ok: false, detail: `unsupported runtime kind '${rt.kind}' for ${descriptor.id}` }
  }

  const tail = rt.subcommand.map((t) => t.split('{profile}').join(ctx.profile))
  if (sub) tail.push(sub)
  return { ok: true, args: [...args, ...tail] }
}

/**
 * What a health answer means, per kind. Kept here rather than in the supervisor so the vocabulary a
 * descriptor may use is stated in one place, next to the descriptors that use it.
 *
 * `reachable` exists because DSH answers 401 to its guarded endpoints and 404 to everything else. A
 * health model that only understood "2xx means up" would report a working host as down.
 */
export function healthKind(descriptor, which) {
  const h = descriptor.health?.[which]
  if (!h) return { kind: 'none', why: `this service declares no ${which} probe` }
  return h
}

/** How the data layer is asked a real question. Returns null when the service has no data layer. */
export function dataProbe(descriptor) {
  return descriptor.data?.probe ?? null
}

/** Whether the descriptor's data layer speaks postgres, which is what decides which probe module runs. */
export function dataKind(descriptor) {
  return descriptor.data?.kind ?? null
}

/** The port a probe should use, resolved from the context by the name the descriptor gives. */
export function probePort(descriptor, portRef, ctx) {
  // Param named portRef, not `which`: a parameter sharing a name with a function another module
  // exports is read by the import lint as a reference to that function.
  if (portRef === 'port') return ctx.port
  if (portRef === 'pgPort') return ctx.pgPort
  const n = Number(portRef)
  return Number.isFinite(n) ? n : null
}
