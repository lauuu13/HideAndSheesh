import { WebPlugin } from '@capacitor/core';

export class HostServerWeb extends WebPlugin {
  async start() {
    throw new Error('Host mode requires the native Android app — not supported in a browser tab.');
  }
  async stop() {
    return {};
  }
  async getLocalIp() {
    throw new Error('Host mode requires the native Android app — not supported in a browser tab.');
  }
}
