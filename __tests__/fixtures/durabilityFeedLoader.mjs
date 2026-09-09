// Test-only loader: real server/Next/SQLite, with both remote feed connections
// redirected to one local fixture. Production code has no test endpoint switch.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ws' && context.parentURL?.endsWith('/server.mjs')) {
    const real = await nextResolve(specifier, context);
    const source = `
      import { WebSocket as RealSocket } from ${JSON.stringify(real.url)};
      export * from ${JSON.stringify(real.url)};
      export class WebSocket extends RealSocket {
        constructor(url, options) {
          super(url.startsWith('wss://live') ? process.env.DURABILITY_FEED_URL : url, options);
        }
      }
    `;
    return { url: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
