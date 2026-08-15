// Host-side no-op entry: the plugin is browser-only (theme registration runs
// in the client), but the loader resolves every patch entry as a package, so
// this entry gives it a valid plugin definition.
export const inject = []

export function apply() {
  // Nothing to do on the host — see ./client.js for the theme registration.
}
