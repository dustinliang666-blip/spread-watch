import { createApp } from './src/app.js';

// Each packaged page is its own Replay session. No server, secrets, or send path.
const app = createApp({ generation: 'offline' });
export const snapshot = async () => ({ ...app.snapshot(), sdkAvailable: true });
export const command = async (input) => ({ ...app.command(input), sdkAvailable: true });
