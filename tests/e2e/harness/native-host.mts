// The native messaging host Chromium runs for `io.tirth.margin`: a stand-in
// for Safari's extension handler (engines/webkit/browsers/safari/app/handler/SafariWebExtensionHandler.swift)
// and for what Margin.app dispatches into the extension. It passes every
// message from the extension to the test (relay.ts) over a local TCP socket,
// one JSON line each, and writes back to Chromium what the test sends.
// Chromium runs one process for the lasting port (runtime.connectNative) and
// one per one-off message (runtime.sendNativeMessage).
import { connect } from 'node:net';

const control = connect(Number(process.env.MARGIN_E2E_RELAY), '127.0.0.1');
control.on('error', () => process.exit(0));
control.on('close', () => process.exit(0));
control.write(JSON.stringify({ start: true }) + '\n');

let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32LE(0);
    if (input.length < 4 + size) return;
    const msg = JSON.parse(input.subarray(4, 4 + size).toString('utf8'));
    input = input.subarray(4 + size);
    control.write(JSON.stringify({ msg }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));

let lines = '';
control.on('data', (chunk) => {
  lines += chunk;
  for (let i; (i = lines.indexOf('\n')) >= 0;) {
    const body = Buffer.from(lines.slice(0, i), 'utf8');
    lines = lines.slice(i + 1);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  }
});
