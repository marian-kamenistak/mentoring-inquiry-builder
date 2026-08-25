/**
 * read-secret — CANONICAL SOURCE. Copy into a project as `src/lib/read-secret.ts`
 * (or `worker/read-secret.ts`) and keep the copies identical. There is no shared
 * package across these Workers; the estate duplicates small helpers this way on
 * purpose (same convention as `form-alert.ts`).
 *
 * WHY THIS EXISTS
 * ---------------
 * Turnstile verification secrets and HMAC signing secrets cannot live in Composio —
 * they are not delegated third-party auth, so there is nothing to broker. They moved
 * to the Cloudflare **Secrets Store** instead, where a secret is account-level and
 * attached by a `secrets_store_secrets` binding rather than `wrangler secret put`.
 *
 * The catch: a Secrets Store binding is NOT a string. It is an object exposing an
 * async `.get()`. So `env.TURNSTILE_SECRET` — which used to be the secret — becomes
 * `[object Object]` the moment a Worker is switched over. Passed to Turnstile
 * siteverify that yields `invalid-input-secret`, which fails CLOSED and blocks every
 * submission. That is precisely the elc-conference.io/cfp outage of 2026-08-25,
 * re-created by a config change.
 *
 * `readSecret` accepts BOTH shapes, so a Worker's code is correct before, during and
 * after the cutover. That is what makes the migration reversible: to roll a Worker
 * back you revert its `wrangler.jsonc` binding and restore the plain secret — no code
 * change, no redeploy of application logic.
 *
 * DESIGN RULES (do not "simplify" these away)
 * -------------------------------------------
 * 1. Returns `undefined` for a missing secret, never `""`. An empty string is a
 *    *valid-looking* argument that siteverify rejects with a confusing error; an
 *    `undefined` lets the caller's existing "secret not configured" branch fire.
 * 2. Never throws. A store read that fails must degrade the same way a missing
 *    plain secret already did.
 * 3. Never logs the value. Callers log the Turnstile *error code*, never the secret.
 */

type SecretsStoreBinding = { get: () => Promise<string> };

function isStoreBinding(v: unknown): v is SecretsStoreBinding {
  return typeof v === "object" && v !== null && typeof (v as SecretsStoreBinding).get === "function";
}

/**
 * Resolve a secret that may be either a plain Worker secret (string) or a
 * Secrets Store binding (object with async `.get()`).
 */
export async function readSecret(value: unknown): Promise<string | undefined> {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (isStoreBinding(value)) {
    try {
      const v = await value.get();
      return typeof v === "string" && v.length > 0 ? v : undefined;
    } catch {
      // Treat an unreadable store secret exactly like an absent one.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Resolve several store bindings at the entry point and hand back a shallow copy
 * of `env` in which those keys are plain strings.
 *
 * Use this when a Worker threads `env` through typed interfaces (`{ FOO?: string }`)
 * into other modules. Normalising once at the top keeps every downstream call site
 * and type signature unchanged — which is both a far smaller diff and a smaller
 * chance of missing one usage and shipping "[object Object]" into a signature check.
 *
 * A resolved key that is absent is deleted rather than set to undefined, so existing
 * `if (!env.FOO)` guards behave exactly as they did with a plain secret.
 */
export async function resolveSecrets<T extends Record<string, unknown>>(
  env: T,
  names: readonly string[]
): Promise<T> {
  const out: Record<string, unknown> = { ...env };
  for (const name of names) {
    if (!(name in out)) continue;
    const v = await readSecret(out[name]);
    if (v === undefined) delete out[name];
    else out[name] = v;
  }
  return out as T;
}
