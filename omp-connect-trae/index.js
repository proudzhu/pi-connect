/**
 * OMP (oh-my-pi) adapter for `pi-connect-trae`.
 *
 * OMP and Pi disagree on the provider-registration surface:
 *
 *   Pi  : pi.registerProvider(providerObject)
 *   OMP : pi.registerProvider(name, config)
 *
 * Loading `pi-connect-trae/index.js` directly therefore passes a provider
 * object as OMP's `name` and leaves `config` undefined; OMP then dereferences
 * `config.streamSimple` and aborts the extension load with
 * "undefined is not an object (evaluating 'p.streamSimple')".
 *
 * This adapter runs the Pi factory with a proxy that captures its provider
 * objects, then re-registers each authenticated region through OMP's
 * declarative API. OMP's provider config has no per-request auth hook, so the
 * loopback shim's URL and bearer token — both only known once a region is
 * resolved — are resolved up front. The shim stays in-process for the
 * session's lifetime, which is what makes the static baseUrl/apiKey valid.
 *
 * The adapter is loaded as an OMP extension module, so OMP's legacy Pi compat
 * layer rewrites the package's `@earendil-works/*` imports onto its bundled
 * host modules.
 *
 * Trade-off: unlike the Pi entry point (which starts no sockets in the
 * factory), OMP registration must resolve each region before it can hand over
 * a usable baseUrl/token. A cold start therefore pays the model-directory
 * discovery once; after that the on-disk catalog makes it a short wait.
 */
import activate from "../pi-connect-trae/index.js";

/** Region registrations resolved on the first factory call, reused afterwards. */
let registrations;

/** Convert Pi's model descriptor to OMP's ProviderModelConfig. */
function toOmpModel(m) {
  const input = (m.input ?? ["text"]).filter((value) => value === "text" || value === "image");
  return {
    id: m.id,
    name: m.name,
    reasoning: Boolean(m.reasoning),
    input: input.length > 0 ? input : ["text"],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

async function resolveRegistrations(pi) {
  const captured = [];
  const proxy = new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerProvider") {
        return (provider) => {
          captured.push(provider);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await activate(proxy);

  const resolved = [];
  for (const provider of captured) {
    let resolution;
    try {
      resolution = await provider.auth?.apiKey?.resolve({});
    } catch (error) {
      console.warn(`[trae-omp] ${provider.id}: region resolve failed`, error);
      continue;
    }
    const auth = resolution?.auth;
    if (auth?.apiKey === undefined || auth?.baseUrl === undefined) continue;
    const models = provider.getModels().map(toOmpModel);
    if (models.length === 0) continue;
    resolved.push({
      name: provider.id,
      config: {
        baseUrl: auth.baseUrl,
        apiKey: auth.apiKey,
        api: "openai-completions",
        models,
      },
    });
  }
  return resolved;
}

export default async function (pi) {
  // Child sessions bind a fresh API and run factories again. Reuse the first
  // resolution: registering again is required, but a second shim is not.
  registrations ??= await resolveRegistrations(pi);
  for (const { name, config } of registrations) pi.registerProvider(name, config);
}
