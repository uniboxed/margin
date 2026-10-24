const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onInstalled.addListener((details) => {
  console.log('[margin] installed', details.reason);
});

api.commands?.onCommand.addListener((command) => {
  console.log('[margin] command', command);
});
