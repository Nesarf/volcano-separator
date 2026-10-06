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

/** Every descriptor this build knows. One for now, and the shape is what makes a second one possible. */
export const SERVICE_DESCRIPTORS = {
  [HINDSIGHT.id]: HINDSIGHT,
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
  const envHome = (descriptor.layout.home.env ?? [])
    .map((e) => process.env[e])
    .find((v) => typeof v === 'string' && v.length > 0)
  const home = resolve(envHome ?? descriptor.layout.home.default.replace(/^~/, homedir()))

  const configFile = cfg.serviceConfigFile ?? expandPath(descriptor.layout.configFile, { home })

  // The plugin's own settings, read before the profile is known, because the profile can come from a
  // command-line flag while other settings can only come from here.
  let pluginCfg = {}
  if (existsSync(configFile)) {
    const parsed = readJsonLoose(configFile)
    if (parsed && typeof parsed === 'object') pluginCfg = parsed
  }

  const profile = requested ?? cfg.defaultProfile ?? 'coding-agent'
  const moduleName = descriptor.runtime.module
  const userHome = homedir()
  const vars = { home, userHome, profile, module: moduleName, instanceName: descriptor.layout.instanceName.replace('{module}', moduleName).replace('{profile}', profile) }

  const profileDir = expandPath(descriptor.layout.profileDir, vars)
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
    profileDir,
    profileEnvFile: expandPath(descriptor.layout.profileEnv, vars),
    profileLogFile: expandPath(descriptor.layout.profileLog, vars),
    profileLockFile: expandPath(descriptor.layout.profileLock, vars),
    daemonLogFile: expandPath(descriptor.layout.daemonLog, vars),
    dataDir: expandPath(descriptor.layout.dataDir, vars),
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
  const version = ctx.embedVersion ?? ctx[rt.versionFrom]?.embedVersion ?? null
  if (!version) {
    return { ok: false, detail: `cannot build the command line: no ${rt.versionFrom}.version is known for ${descriptor.id}` }
  }
  // Named uvArgs, not uvFlags: `uvFlags` is a function supervisor.mjs exports, and an option sharing
  // that name is read by the import lint as a reference to it.
  const args = [...uvArgs]
  if (offline) args.push('--offline')
  args.push('--with', ...(ctx.withPackages ?? rt.packages), `${rt.module}@${version}`)
  const tail = rt.subcommand.map((t) => t.split('{profile}').join(ctx.profile))
  if (sub) tail.push(sub)
  return { ok: true, args: [...args, ...tail] }
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
